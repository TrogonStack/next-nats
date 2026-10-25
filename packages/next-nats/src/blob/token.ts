import { getBlobConfig, getBlobSecret } from "./config.js";
import { BlobAccessError, BlobClientTokenExpiredError, BlobError } from "./errors.js";
import { blobUrl } from "./url.js";
import type {
  DecodedClientTokenPayload,
  DelegationOperation,
  GenerateClientTokenOptions,
  IssuedSignedToken,
  IssueSignedTokenOptions,
  PresignedUrlPayload,
  PresignUrlOptions,
  PresignUrlResult,
} from "./types.js";

export const CLIENT_TOKEN_PREFIX = "blob_client_";
export const SIGNATURE_HEADER = "x-blob-signature";
const ONE_HOUR = 60 * 60 * 1000;
const ALL_OPERATIONS: DelegationOperation[] = ["get", "head", "put", "delete"];

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function encodeJson(value: unknown): string {
  return toBase64Url(encoder.encode(JSON.stringify(value)));
}

function decodeJson<T>(text: string): T {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(text))) as T;
}

async function hmac(key: string, data: string): Promise<string> {
  const imported = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", imported, encoder.encode(data))));
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function seal(payload: object, key: string): Promise<string> {
  const body = encodeJson(payload);
  return `${body}.${await hmac(key, body)}`;
}

async function open<T>(token: string, key: string): Promise<T> {
  const [body, signature] = token.split(".");
  if (!body || !signature || !equal(await hmac(key, body), signature)) throw new BlobAccessError();
  try {
    return decodeJson<T>(body);
  } catch {
    throw new BlobAccessError();
  }
}

export async function generateClientTokenFromReadWriteToken(options: GenerateClientTokenOptions): Promise<string> {
  const { token: _token, abortSignal: _signal, oidcToken: _oidc, storeId: _store, ...rest } = options;
  if (!rest.pathname) throw new BlobError("pathname is required", { reason: "INVALID_PATHNAME", subject: "/pathname" });
  const payload: DecodedClientTokenPayload = { ...rest, validUntil: rest.validUntil ?? Date.now() + ONE_HOUR };
  return `${CLIENT_TOKEN_PREFIX}${await seal(payload, getBlobSecret())}`;
}

export function getPayloadFromClientToken(clientToken: string): DecodedClientTokenPayload {
  const sealed = clientToken.startsWith(CLIENT_TOKEN_PREFIX) ? clientToken.slice(CLIENT_TOKEN_PREFIX.length) : clientToken;
  try {
    return decodeJson<DecodedClientTokenPayload>(sealed.split(".")[0] ?? "");
  } catch {
    throw new BlobError("Invalid client token");
  }
}

export async function verifyClientToken(clientToken: string, now = Date.now()): Promise<DecodedClientTokenPayload> {
  if (!clientToken.startsWith(CLIENT_TOKEN_PREFIX)) throw new BlobAccessError();
  const payload = await open<DecodedClientTokenPayload>(clientToken.slice(CLIENT_TOKEN_PREFIX.length), getBlobSecret());
  if (payload.validUntil < now) throw new BlobClientTokenExpiredError();
  return payload;
}

export function signCallbackBody(body: string): Promise<string> {
  return hmac(getBlobSecret(), `callback:${body}`);
}

export async function verifyCallbackSignature(signature: string, body: string): Promise<boolean> {
  return equal(await signCallbackBody(body), signature);
}

interface DelegationPayload {
  storeId: string;
  pathname?: string;
  operations: DelegationOperation[];
  validUntil: number;
  allowedContentTypes?: string[];
  maximumSizeInBytes?: number;
}

function clientSigningTokenFor(delegationToken: string): Promise<string> {
  return hmac(getBlobSecret(), `delegation:${delegationToken}`);
}

export async function issueSignedToken(options: IssueSignedTokenOptions): Promise<IssuedSignedToken> {
  const validUntil = options.validUntil ?? Date.now() + ONE_HOUR;
  const payload: DelegationPayload = {
    storeId: options.storeId ?? getBlobConfig().bucket,
    operations: options.operations ?? ALL_OPERATIONS,
    validUntil,
    ...(options.pathname !== undefined && { pathname: options.pathname }),
    ...(options.allowedContentTypes !== undefined && { allowedContentTypes: options.allowedContentTypes }),
    ...(options.maximumSizeInBytes !== undefined && { maximumSizeInBytes: options.maximumSizeInBytes }),
  };
  const delegationToken = await seal(payload, getBlobSecret());
  return { delegationToken, clientSigningToken: await clientSigningTokenFor(delegationToken), validUntil };
}

export function parseStoreIdFromDelegationToken(delegationToken: string): string {
  try {
    const { storeId } = decodeJson<DelegationPayload>(delegationToken.split(".")[0] ?? "");
    if (storeId) return storeId;
  } catch {}
  throw new BlobError("Invalid delegation token");
}

export function parseStoreIdFromPresignedUrl(payload: PresignedUrlPayload): string {
  return parseStoreIdFromDelegationToken(payload.delegationToken);
}

function canonical(params: Record<string, string>): string {
  return JSON.stringify(Object.keys(params).sort().map((key) => [key, params[key]]));
}

export function presignedUrlFromPayload(payload: PresignedUrlPayload): string {
  const query = new URLSearchParams({ delegationToken: payload.delegationToken, signature: payload.signature });
  for (const [key, value] of Object.entries(payload.params)) query.set(key, value);
  return `${blobUrl(payload.params.pathname ?? "")}?${query}`;
}

export async function presignPayload(
  signedToken: Pick<IssuedSignedToken, "clientSigningToken" | "delegationToken">,
  options: PresignUrlOptions & { access: "public" | "private" },
): Promise<PresignedUrlPayload> {
  const { delegationToken, clientSigningToken } = signedToken;
  const delegation = decodeJson<DelegationPayload>(delegationToken.split(".")[0] ?? "");
  const validUntil = Math.min(options.validUntil ?? Date.now() + ONE_HOUR, delegation.validUntil);
  const params: Record<string, string> = {
    operation: options.operation,
    pathname: options.pathname,
    access: options.access,
    validUntil: String(validUntil),
  };
  if (options.operation === "put") {
    if (options.allowedContentTypes) params.allowedContentTypes = JSON.stringify(options.allowedContentTypes);
    if (options.maximumSizeInBytes !== undefined) params.maximumSizeInBytes = String(options.maximumSizeInBytes);
    if (options.allowOverwrite !== undefined) params.allowOverwrite = String(options.allowOverwrite);
    if (options.addRandomSuffix !== undefined) params.addRandomSuffix = String(options.addRandomSuffix);
    if (options.cacheControlMaxAge !== undefined) params.cacheControlMaxAge = String(options.cacheControlMaxAge);
    if (options.ifMatch !== undefined) params.ifMatch = options.ifMatch;
    if (options.onUploadCompleted) {
      params.callbackUrl = options.onUploadCompleted.callbackUrl;
      if (options.onUploadCompleted.tokenPayload !== undefined) params.tokenPayload = options.onUploadCompleted.tokenPayload;
    }
  }
  if (options.operation === "delete" && options.ifMatch !== undefined) params.ifMatch = options.ifMatch;
  const signature = await hmac(clientSigningToken, canonical(params));
  return { delegationToken, signature, params };
}

export async function presignUrl(
  signedToken: Pick<IssuedSignedToken, "clientSigningToken" | "delegationToken">,
  options: PresignUrlOptions & { access: "public" | "private" },
): Promise<PresignUrlResult> {
  return { presignedUrl: presignedUrlFromPayload(await presignPayload(signedToken, options)) };
}

export interface Grant {
  operation: DelegationOperation;
  pathname: string;
  access?: "public" | "private";
  allowedContentTypes?: string[];
  maximumSizeInBytes?: number;
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
  cacheControlMaxAge?: number;
  ifMatch?: string;
  onUploadCompleted?: { callbackUrl: string; tokenPayload?: string | null };
}

const NON_PARAMS = new Set(["delegationToken", "signature", "download", "mpu", "uploadId", "key", "partNumber", "token"]);

export async function verifyPresignedParams(search: URLSearchParams, now = Date.now()): Promise<Grant> {
  const delegationToken = search.get("delegationToken");
  const signature = search.get("signature");
  if (!delegationToken || !signature) throw new BlobAccessError();
  const secret = getBlobSecret();
  const delegation = await open<DelegationPayload>(delegationToken, secret);
  const params: Record<string, string> = {};
  search.forEach((value, key) => {
    if (!NON_PARAMS.has(key)) params[key] = value;
  });
  if (!equal(await hmac(await clientSigningTokenFor(delegationToken), canonical(params)), signature)) throw new BlobAccessError();
  const validUntil = Math.min(Number(params.validUntil), delegation.validUntil);
  if (!(validUntil >= now)) throw new BlobClientTokenExpiredError();
  const operation = params.operation as DelegationOperation;
  const pathname = params.pathname ?? "";
  if (!delegation.operations.includes(operation)) throw new BlobAccessError();
  if (delegation.pathname !== undefined && delegation.pathname !== pathname) {
    if (!delegation.pathname.endsWith("/") || !pathname.startsWith(delegation.pathname)) throw new BlobAccessError();
  }
  const allowed = params.allowedContentTypes ? (JSON.parse(params.allowedContentTypes) as string[]) : delegation.allowedContentTypes;
  const sizes = [delegation.maximumSizeInBytes, params.maximumSizeInBytes ? Number(params.maximumSizeInBytes) : undefined].filter(
    (n): n is number => n !== undefined,
  );
  return {
    operation,
    pathname,
    access: params.access as "public" | "private",
    ...(allowed && { allowedContentTypes: allowed }),
    ...(sizes.length > 0 && { maximumSizeInBytes: Math.min(...sizes) }),
    ...(params.allowOverwrite !== undefined && { allowOverwrite: params.allowOverwrite === "true" }),
    ...(params.addRandomSuffix !== undefined && { addRandomSuffix: params.addRandomSuffix === "true" }),
    ...(params.cacheControlMaxAge !== undefined && { cacheControlMaxAge: Number(params.cacheControlMaxAge) }),
    ...(params.ifMatch !== undefined && { ifMatch: params.ifMatch }),
    ...(params.callbackUrl && {
      onUploadCompleted: { callbackUrl: params.callbackUrl, ...(params.tokenPayload !== undefined && { tokenPayload: params.tokenPayload }) },
    }),
  };
}

export async function grantFromClientToken(clientToken: string): Promise<Grant> {
  const payload = await verifyClientToken(clientToken);
  return {
    operation: "put",
    pathname: payload.pathname,
    ...(payload.allowedContentTypes && { allowedContentTypes: payload.allowedContentTypes }),
    ...(payload.maximumSizeInBytes !== undefined && { maximumSizeInBytes: payload.maximumSizeInBytes }),
    ...(payload.addRandomSuffix !== undefined && { addRandomSuffix: payload.addRandomSuffix }),
    ...(payload.allowOverwrite !== undefined && { allowOverwrite: payload.allowOverwrite }),
    ...(payload.cacheControlMaxAge !== undefined && { cacheControlMaxAge: payload.cacheControlMaxAge }),
    ...(payload.ifMatch !== undefined && { ifMatch: payload.ifMatch }),
    ...(payload.onUploadCompleted && { onUploadCompleted: payload.onUploadCompleted }),
  };
}
