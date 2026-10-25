import type { IncomingMessage } from "node:http";
import { getBlobConfig } from "./config.js";
import { BlobError, BlobRequestAbortedError, blobErrorFromResponse } from "./errors.js";
import {
  CLIENT_TOKEN_PREFIX,
  SIGNATURE_HEADER,
  generateClientTokenFromReadWriteToken,
  getPayloadFromClientToken,
  presignPayload,
  presignedUrlFromPayload,
  verifyCallbackSignature,
} from "./token.js";
import type {
  BlobAccessType,
  BlobClientTokenConstraintOptions,
  CommonCompleteMultipartUploadOptions,
  CommonMultipartUploadOptions,
  CreateFolderCommandOptions,
  CreateFolderResult,
  FileLike,
  GenerateClientTokenOptions,
  IssuedSignedToken,
  IssueSignedTokenOptions,
  Part,
  PresignedUrlPayload,
  PresignPutUrlOptions,
  PutBlobResult,
  PutBody,
  WithUploadProgress,
} from "./types.js";

export { generateClientTokenFromReadWriteToken, getPayloadFromClientToken };
export type { GenerateClientTokenOptions };
export type { DecodedClientTokenPayload } from "./types.js";

const PART_SIZE = 8 * 1024 * 1024;
const PARALLEL_PARTS = 4;

export interface ClientCommonCreateBlobOptions {
  access: BlobAccessType;
  contentType?: string;
  abortSignal?: AbortSignal;
}

export interface ClientTokenOptions {
  token: string;
}

interface ClientCommonPutOptions extends ClientCommonCreateBlobOptions, WithUploadProgress {
  multipart?: boolean;
}

export type ClientPutCommandOptions = ClientCommonPutOptions & ClientTokenOptions;
export type ClientCreateMultipartUploadCommandOptions = ClientCommonCreateBlobOptions & ClientTokenOptions;
type ClientMultipartUploadCommandOptions = ClientCommonCreateBlobOptions &
  ClientTokenOptions &
  CommonMultipartUploadOptions &
  WithUploadProgress;
type ClientCompleteMultipartUploadCommandOptions = ClientCommonCreateBlobOptions &
  ClientTokenOptions &
  CommonCompleteMultipartUploadOptions;

export interface CommonUploadOptions {
  handleUploadUrl: string;
  clientPayload?: string;
  headers?: Record<string, string>;
}

export type UploadOptions = ClientCommonPutOptions & CommonUploadOptions;

function endpoint(pathname: string, query: Record<string, string | number | undefined> = {}): string {
  const base = getBlobConfig().baseUrl.replace(/\/+$/, "");
  const url = `${base}/${pathname.split("/").map(encodeURIComponent).join("/")}`;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return text ? `${url}?${text}` : url;
}

async function toBlob(body: PutBody): Promise<Blob> {
  if (typeof body === "string") return new Blob([body]);
  if (body instanceof Blob) return body;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new Blob([body as BlobPart]);
  if (body instanceof ReadableStream) return new Response(body).blob();
  if (typeof (body as FileLike).arrayBuffer === "function") return new Blob([await (body as FileLike).arrayBuffer()]);
  if (typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    return new Response((ReadableStream as unknown as { from(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> }).from(body as AsyncIterable<Uint8Array>)).blob();
  }
  throw new BlobError("Unsupported blob body type", { reason: "UNSUPPORTED_BODY" });
}

function assertClientToken(token: string | undefined, method: string): asserts token is string {
  if (!token?.startsWith(CLIENT_TOKEN_PREFIX)) throw new BlobError(`${method} must be called with a client token`);
}

function rejectServerOptions(options: object, method: string): void {
  const forbidden = ["addRandomSuffix", "allowOverwrite", "cacheControlMaxAge", "ifMatch"];
  const found = forbidden.some((key) => (options as Record<string, unknown>)[key] !== undefined);
  if (found) {
    throw new BlobError(
      `${method} doesn't allow \`addRandomSuffix\`, \`cacheControlMaxAge\`, \`allowOverwrite\` or \`ifMatch\`. Configure these options at the server side when generating client tokens.`,
    );
  }
}

async function send(
  url: string,
  init: RequestInit,
  token: string | undefined,
  options: { access: BlobAccessType; contentType?: string; abortSignal?: AbortSignal },
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  headers.set("x-blob-access", options.access);
  if (options.contentType) headers.set("x-content-type", options.contentType);
  try {
    const response = await fetch(url, { ...init, headers, signal: options.abortSignal });
    if (!response.ok) throw await blobErrorFromResponse(response);
    return response;
  } catch (error) {
    if (options.abortSignal?.aborted) throw new BlobRequestAbortedError();
    throw error;
  }
}

function report(callback: WithUploadProgress["onUploadProgress"], loaded: number, total: number): void {
  callback?.({ loaded, total, percentage: total ? Math.round((loaded / total) * 100) : 100 });
}

async function putVia(
  url: string,
  token: string | undefined,
  body: PutBody,
  options: ClientCommonPutOptions,
  pathname: string,
): Promise<PutBlobResult> {
  const blob = await toBlob(body);
  report(options.onUploadProgress, 0, blob.size);
  const contentType = options.contentType ?? (blob.type || undefined);
  const response = await send(url, { method: "PUT", body: blob, headers: contentType ? { "content-type": contentType } : {} }, token, {
    ...options,
    contentType,
  });
  report(options.onUploadProgress, blob.size, blob.size);
  return (await response.json()) as PutBlobResult;
}

async function putMultipart(
  pathname: string,
  body: PutBody,
  token: string | undefined,
  options: ClientCommonPutOptions,
  open: (contentType: string | undefined) => Promise<{ key: string; uploadId: string }>,
  uploadOne: (target: { key: string; uploadId: string }, partNumber: number, chunk: Blob) => Promise<Part>,
  close: (target: { key: string; uploadId: string }, parts: Part[]) => Promise<PutBlobResult>,
): Promise<PutBlobResult> {
  const blob = await toBlob(body);
  const contentType = options.contentType ?? (blob.type || undefined);
  const target = await open(contentType);
  const count = Math.max(1, Math.ceil(blob.size / PART_SIZE));
  const parts: Part[] = new Array(count);
  let next = 0;
  let loaded = 0;
  report(options.onUploadProgress, 0, blob.size);
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_PARTS, count) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= count) return;
        const chunk = blob.slice(index * PART_SIZE, (index + 1) * PART_SIZE);
        parts[index] = await uploadOne(target, index + 1, chunk);
        loaded += chunk.size;
        report(options.onUploadProgress, loaded, blob.size);
      }
    }),
  );
  return close(target, parts);
}

export async function createMultipartUpload(
  pathname: string,
  options: ClientCreateMultipartUploadCommandOptions,
): Promise<{ key: string; uploadId: string }> {
  assertClientToken(options?.token, "client/`createMultipartUpload`");
  rejectServerOptions(options, "client/`createMultipartUpload`");
  const response = await send(endpoint(pathname, { mpu: "create" }), { method: "POST" }, options.token, options);
  return (await response.json()) as { key: string; uploadId: string };
}

export async function uploadPart(pathname: string, body: PutBody, options: ClientMultipartUploadCommandOptions): Promise<Part> {
  assertClientToken(options?.token, "client/`multipartUpload`");
  rejectServerOptions(options, "client/`multipartUpload`");
  const blob = await toBlob(body);
  report(options.onUploadProgress, 0, blob.size);
  const url = endpoint(pathname, { mpu: "part", uploadId: options.uploadId, key: options.key, partNumber: options.partNumber });
  const response = await send(url, { method: "PUT", body: blob }, options.token, options);
  report(options.onUploadProgress, blob.size, blob.size);
  return (await response.json()) as Part;
}

export async function completeMultipartUpload(
  pathname: string,
  parts: Part[],
  options: ClientCompleteMultipartUploadCommandOptions,
): Promise<PutBlobResult> {
  assertClientToken(options?.token, "client/`completeMultipartUpload`");
  rejectServerOptions(options, "client/`completeMultipartUpload`");
  const url = endpoint(pathname, { mpu: "complete", uploadId: options.uploadId, key: options.key });
  const response = await send(
    url,
    { method: "POST", body: JSON.stringify(parts), headers: { "content-type": "application/json" } },
    options.token,
    options,
  );
  return (await response.json()) as PutBlobResult;
}

export async function createMultipartUploader(pathname: string, options: ClientCreateMultipartUploadCommandOptions) {
  const { key, uploadId } = await createMultipartUpload(pathname, options);
  return {
    key,
    uploadId,
    uploadPart(partNumber: number, body: PutBody): Promise<{ etag: string; partNumber: number }> {
      return uploadPart(pathname, body, { ...options, key, uploadId, partNumber });
    },
    complete(parts: Part[]): Promise<PutBlobResult> {
      return completeMultipartUpload(pathname, parts, { ...options, key, uploadId });
    },
  };
}

export async function put(pathname: string, body: PutBody, options: ClientPutCommandOptions): Promise<PutBlobResult> {
  assertClientToken(options?.token, "client/`put`");
  rejectServerOptions(options, "client/`put`");
  return uploadWithToken(pathname, body, options.token, options);
}

function uploadWithToken(pathname: string, body: PutBody, token: string, options: ClientCommonPutOptions): Promise<PutBlobResult> {
  if (!options.multipart) return putVia(endpoint(pathname), token, body, options, pathname);
  return putMultipart(
    pathname,
    body,
    token,
    options,
    (contentType) => createMultipartUpload(pathname, { access: options.access, token, contentType, abortSignal: options.abortSignal }),
    (target, partNumber, chunk) =>
      uploadPart(pathname, chunk, { access: options.access, token, abortSignal: options.abortSignal, ...target, partNumber }),
    (target, parts) => completeMultipartUpload(pathname, parts, { access: options.access, token, abortSignal: options.abortSignal, ...target }),
  );
}

async function postJson<T>(options: CommonUploadOptions & { abortSignal?: AbortSignal }, body: unknown, failure: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(options.handleUploadUrl, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...options.headers },
      signal: options.abortSignal,
    });
  } catch (error) {
    if (options.abortSignal?.aborted) throw new BlobRequestAbortedError();
    throw error;
  }
  if (!response.ok) throw new BlobError(failure);
  return (await response.json()) as T;
}

function rejectUploadOptions(options: UploadOptions, method: string): void {
  if (options.handleUploadUrl === undefined) throw new BlobError(`client/\`${method}\` requires the 'handleUploadUrl' parameter`);
  rejectServerOptions(options, `client/\`${method}\``);
}

export async function upload(pathname: string, body: PutBody, options: UploadOptions): Promise<PutBlobResult> {
  rejectUploadOptions(options, "upload");
  const { clientToken } = await postJson<{ clientToken: string }>(
    options,
    {
      type: EventTypes.generateClientToken,
      payload: { pathname, clientPayload: options.clientPayload ?? null, multipart: options.multipart ?? false },
    },
    "Failed to retrieve the client token",
  );
  return uploadWithToken(pathname, body, clientToken, options);
}

export async function uploadPresigned(pathname: string, body: PutBody, options: UploadOptions): Promise<PutBlobResult> {
  rejectUploadOptions(options, "uploadPresigned");
  const { presignedUrlPayload } = await postJson<{ presignedUrlPayload: PresignedUrlPayload }>(
    options,
    {
      type: EventTypes.generatePresignedUrl,
      payload: { pathname, clientPayload: options.clientPayload ?? null, multipart: options.multipart ?? false },
    },
    "Failed to retrieve the presigned URL payload",
  );
  return putVia(presignedUrlFromPayload(presignedUrlPayload), undefined, body, options, pathname);
}

export async function createFolder(pathname: string, options: CreateFolderCommandOptions = {}): Promise<CreateFolderResult> {
  const folder = pathname.endsWith("/") ? pathname : `${pathname}/`;
  const response = await send(endpoint(folder, { action: "create-folder" }), { method: "POST" }, undefined, {
    access: options.access ?? "public",
    abortSignal: options.abortSignal,
  });
  return (await response.json()) as CreateFolderResult;
}

export const EventTypes = {
  generateClientToken: "blob.generate-client-token",
  generatePresignedUrl: "blob.generate-presigned-url",
  uploadCompleted: "blob.upload-completed",
} as const;

export interface GenerateClientTokenEvent {
  type: (typeof EventTypes)["generateClientToken"];
  payload: { pathname: string; multipart: boolean; clientPayload: string | null };
}

export interface GeneratePresignedUrlEvent {
  type: (typeof EventTypes)["generatePresignedUrl"];
  payload: { pathname: string; multipart: boolean; clientPayload: string | null };
}

export interface UploadCompletedEvent {
  type: (typeof EventTypes)["uploadCompleted"];
  payload: { blob: PutBlobResult; tokenPayload?: string | null };
}

export type HandleUploadBody = GenerateClientTokenEvent | UploadCompletedEvent;
export type HandleUploadPresignedBody = GeneratePresignedUrlEvent | UploadCompletedEvent;
type RequestType = IncomingMessage | Request;

export interface HandleUploadOptions {
  body: HandleUploadBody;
  onBeforeGenerateToken: (
    pathname: string,
    clientPayload: string | null,
    multipart: boolean,
  ) => Promise<
    Pick<
      GenerateClientTokenOptions,
      "allowedContentTypes" | "maximumSizeInBytes" | "validUntil" | "addRandomSuffix" | "allowOverwrite" | "cacheControlMaxAge" | "ifMatch"
    > & { tokenPayload?: string | null; callbackUrl?: string }
  >;
  onUploadCompleted?: (body: UploadCompletedEvent["payload"]) => Promise<void>;
  token?: string;
  request: RequestType;
}

function isFetchRequest(request: RequestType): request is Request {
  return "credentials" in request;
}

function callbackUrlOf(request: RequestType): string {
  if (isFetchRequest(request)) {
    const url = new URL(request.url);
    return `${url.origin}${url.pathname}`;
  }
  const header = (name: string) => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const protocol = header("x-forwarded-proto") ?? "http";
  const host = header("x-forwarded-host") ?? header("host");
  return `${protocol}://${host}${(request.url ?? "").split("?")[0]}`;
}

function signatureOf(request: RequestType): string {
  if (isFetchRequest(request)) return request.headers.get(SIGNATURE_HEADER) ?? "";
  const value = request.headers[SIGNATURE_HEADER];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

async function verifyCompletedEvent(request: RequestType, body: unknown): Promise<void> {
  const signature = signatureOf(request);
  if (!signature) throw new BlobError("Missing callback signature");
  if (!(await verifyCallbackSignature(signature, JSON.stringify(body)))) throw new BlobError("Invalid callback signature");
}

const ONE_HOUR = 60 * 60 * 1000;

export async function handleUpload({
  request,
  body,
  onBeforeGenerateToken,
  onUploadCompleted,
}: HandleUploadOptions): Promise<
  { type: "blob.generate-client-token"; clientToken: string } | { type: "blob.upload-completed"; response: "ok" }
> {
  const type = body.type;
  switch (type) {
    case "blob.generate-client-token": {
      const { pathname, clientPayload, multipart } = body.payload;
      const payload = await onBeforeGenerateToken(pathname, clientPayload, multipart);
      const tokenPayload = payload.tokenPayload ?? clientPayload;
      const { callbackUrl: provided, tokenPayload: _ignored, ...constraints } = payload;
      const callbackUrl = provided ?? (onUploadCompleted ? callbackUrlOf(request) : undefined);
      const options: BlobClientTokenConstraintOptions & { pathname: string } = {
        ...constraints,
        pathname,
        ...(callbackUrl && { onUploadCompleted: { callbackUrl, tokenPayload } }),
        validUntil: payload.validUntil ?? Date.now() + ONE_HOUR,
      };
      return { type, clientToken: await generateClientTokenFromReadWriteToken(options) };
    }
    case "blob.upload-completed": {
      await verifyCompletedEvent(request, body);
      if (onUploadCompleted) await onUploadCompleted(body.payload);
      return { type, response: "ok" };
    }
    default:
      throw new BlobError("Invalid event type");
  }
}

export type HandleUploadPresignedSignedTokenPayload = Pick<
  IssueSignedTokenOptions,
  "allowedContentTypes" | "maximumSizeInBytes" | "operations" | "pathname" | "validUntil"
>;

export interface HandleUploadPresignedIssuanceContext {
  onUploadCompleted?: { callbackUrl: string; tokenPayload?: string | null };
}

export interface HandleUploadPresignedOptions {
  body: HandleUploadPresignedBody;
  getSignedToken: (
    pathname: string,
    clientPayload: string | null,
    multipart: boolean,
  ) => Promise<{
    token: IssuedSignedToken;
    urlOptions?: Omit<PresignPutUrlOptions, "operation" | "pathname" | "onUploadCompleted"> & {
      callbackUrl?: string;
      tokenPayload?: string | null;
    };
  }>;
  webhookPublicKey?: string;
  onUploadCompleted?: HandleUploadOptions["onUploadCompleted"];
  request: RequestType;
}

export async function handleUploadPresigned({
  body,
  request,
  getSignedToken,
  onUploadCompleted,
}: HandleUploadPresignedOptions): Promise<
  { type: "blob.generate-presigned-url"; presignedUrlPayload: PresignedUrlPayload } | { type: "blob.upload-completed"; response: "ok" }
> {
  const type = body.type;
  switch (type) {
    case "blob.generate-presigned-url": {
      const { pathname, clientPayload, multipart } = body.payload;
      const { token, urlOptions = {} } = await getSignedToken(pathname, clientPayload, multipart);
      const { callbackUrl: provided, tokenPayload: providedPayload, ...rest } = urlOptions;
      const tokenPayload = providedPayload ?? clientPayload ?? undefined;
      const callbackUrl = provided ?? (onUploadCompleted ? callbackUrlOf(request) : undefined);
      const presignPayloadResult = await presignPayload(token, {
        ...rest,
        operation: "put",
        pathname,
        access: "public",
        ...(callbackUrl && { onUploadCompleted: { callbackUrl, tokenPayload } }),
      });
      return { type, presignedUrlPayload: presignPayloadResult };
    }
    case "blob.upload-completed": {
      await verifyCompletedEvent(request, body);
      if (onUploadCompleted) await onUploadCompleted(body.payload);
      return { type, response: "ok" };
    }
    default:
      throw new BlobError("Invalid event type");
  }
}
