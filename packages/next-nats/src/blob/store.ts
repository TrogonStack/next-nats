import "server-only";
import type { ObjectInfo, ObjectStore } from "@nats-io/obj";
import { getObjm } from "../connection.js";
import { getBlobConfig } from "./config.js";
import { assertAccess, assertBody, assertConsistentIfMatch, assertPathname } from "./validate.js";
import { chunked, concat, inferContentType, limitSize, toStream } from "./body.js";
import {
  BlobAlreadyExistsError,
  BlobError,
  BlobNotFoundError,
  BlobPreconditionFailedError,
  BlobRequestAbortedError,
} from "./errors.js";
import { blobDownloadUrl, blobUrl, isAllowedBlobUrl, isHttpUrl, rawPathnameOfUrl, resolvePathname } from "./url.js";
import { bodyLength, multipartProgress, uploadProgress, type UploadProgress } from "./progress.js";
import type {
  BlobAccessType,
  BlobCommandOptions,
  CommonCreateBlobOptions,
  CompleteMultipartUploadCommandOptions,
  CreateFolderCommandOptions,
  CreateFolderResult,
  OptimizeImageOptions,
  Part,
  PutBlobResult,
  PutBody,
  UploadPartCommandOptions,
  WithUploadProgress,
} from "./types.js";

export { blobDownloadUrl, blobUrl, resolvePathname, getDownloadUrl } from "./url.js";
export type { BlobAccessType, BlobCommandOptions, PutBlobResult } from "./types.js";

const PART_SIZE = 8 * 1024 * 1024;
const MAX_PARTS = 10_000;
const UPLOAD_TTL_NANOS = 24 * 60 * 60 * 1_000_000_000;

export interface PutCommandOptions extends CommonCreateBlobOptions, WithUploadProgress {
  multipart?: boolean;
  optimizeImage?: OptimizeImageOptions;
}

export interface DeleteCommandOptions extends BlobCommandOptions {
  ifMatch?: string;
}

export interface HeadBlobResult {
  size: number;
  uploadedAt: Date;
  pathname: string;
  contentType: string;
  contentDisposition: string;
  url: string;
  downloadUrl: string;
  cacheControl: string;
  etag: string;
}

export interface ListBlobResultBlob {
  url: string;
  downloadUrl: string;
  pathname: string;
  size: number;
  uploadedAt: Date;
  etag: string;
}

export interface ListBlobResult {
  blobs: ListBlobResultBlob[];
  cursor?: string;
  hasMore: boolean;
}

export interface ListFoldedBlobResult extends ListBlobResult {
  folders: string[];
}

export interface ListCommandOptions<M extends "expanded" | "folded" | undefined = undefined> extends BlobCommandOptions {
  limit?: number;
  prefix?: string;
  cursor?: string;
  mode?: M;
}

export type ListCommandResult<M extends "expanded" | "folded" | undefined = undefined> = M extends "folded"
  ? ListFoldedBlobResult
  : ListBlobResult;

export interface GetCommandOptions extends BlobCommandOptions {
  access: BlobAccessType;
  useCache?: boolean;
  ifNoneMatch?: string;
  headers?: HeadersInit;
}

interface GetBlobResultBlobBase {
  url: string;
  downloadUrl: string;
  pathname: string;
  contentDisposition: string;
  cacheControl: string;
  uploadedAt: Date;
  etag: string;
}

export type GetBlobResult =
  | {
      statusCode: 200;
      stream: ReadableStream<Uint8Array>;
      headers: Headers;
      blob: GetBlobResultBlobBase & { contentType: string; size: number };
    }
  | {
      statusCode: 304;
      stream: null;
      headers: Headers;
      blob: GetBlobResultBlobBase & { contentType: null; size: null };
    };

export type CopyCommandOptions = CommonCreateBlobOptions;
export interface CopyBlobResult extends PutBlobResult {}
export type RenameCommandOptions = CommonCreateBlobOptions;
export interface RenameBlobResult extends PutBlobResult {}

export interface PutImageCommandOptions extends Omit<CommonCreateBlobOptions, "contentType">, WithUploadProgress {
  optimizeImage: OptimizeImageOptions;
}
export type PutImageBlobResult = PutBlobResult;
export interface PutFromUrlCommandOptions extends Omit<CommonCreateBlobOptions, "contentType"> {
  optimizeImage: OptimizeImageOptions;
}
export type PutFromUrlBlobResult = PutBlobResult;

const STORES = Symbol.for("next-nats.blob.stores");

function stores(): Map<string, Promise<ObjectStore>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<ObjectStore>> | undefined>;
  return (g[STORES] ??= new Map());
}

function openStore(bucket: string, ttl?: number): Promise<ObjectStore> {
  const cache = stores();
  let store = cache.get(bucket);
  if (!store) {
    store = getObjm().then((objm) => objm.create(bucket, ttl === undefined ? undefined : { ttl }));
    cache.set(bucket, store);
    store.catch(() => cache.delete(bucket));
  }
  return store;
}

export function getBlobStore(bucket = getBlobConfig().bucket): Promise<ObjectStore> {
  return openStore(bucket);
}

function getUploadStore(): Promise<ObjectStore> {
  return openStore(`${getBlobConfig().bucket}_mpu`, UPLOAD_TTL_NANOS);
}

export function etagOf(info: ObjectInfo): string {
  return `"${info.digest.replace(/^SHA-256=/, "")}"`;
}

function dispositionFor(pathname: string, meta?: Record<string, string>): string {
  if (meta?.contentDisposition) return meta.contentDisposition;
  const name = pathname.split("/").pop() ?? pathname;
  return `inline; filename="${name.replace(/"/g, "")}"`;
}

function cacheControlFor(meta?: Record<string, string>): string {
  return meta?.cacheControl ?? "public, max-age=2592000";
}

export function describe(info: ObjectInfo) {
  const meta = info.metadata;
  return {
    pathname: info.name,
    url: blobUrl(info.name),
    downloadUrl: blobDownloadUrl(info.name),
    contentType: meta?.contentType ?? inferContentType(info.name),
    contentDisposition: dispositionFor(info.name, meta),
    cacheControl: cacheControlFor(meta),
    access: (meta?.access as BlobAccessType | undefined) ?? "public",
    size: info.size,
    uploadedAt: new Date(info.mtime),
    etag: etagOf(info),
  };
}

export async function statBlob(pathname: string, store?: ObjectStore): Promise<ObjectInfo | null> {
  const info = await (store ?? (await getBlobStore())).info(pathname);
  return info && !info.deleted ? info : null;
}

const SUFFIX_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SUFFIX_LENGTH = 30;

function randomSuffix(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(SUFFIX_LENGTH)), (b) => SUFFIX_ALPHABET[b % SUFFIX_ALPHABET.length]).join("");
}

function withSuffix(pathname: string): string {
  const slash = pathname.lastIndexOf("/");
  const dot = pathname.lastIndexOf(".");
  if (dot > slash + 1) return `${pathname.slice(0, dot)}-${randomSuffix()}${pathname.slice(dot)}`;
  return `${pathname}-${randomSuffix()}`;
}

function unsupportedImageOptimization(): BlobError {
  return new BlobError("Image optimization is not available on this store, remove `optimizeImage`", {
    reason: "IMAGE_OPTIMIZATION_UNSUPPORTED",
  });
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BlobRequestAbortedError();
}

async function aborting<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  assertNotAborted(signal);
  try {
    return await run();
  } catch (error) {
    if (signal?.aborted) throw new BlobRequestAbortedError();
    throw error;
  }
}

interface StoreRequest {
  access: BlobAccessType;
  contentType?: string;
  cacheControlMaxAge?: number;
  allowOverwrite?: boolean;
  ifMatch?: string;
  maximumSizeInBytes?: number;
  progress?: UploadProgress;
  abortSignal?: AbortSignal;
}

async function storeStream(name: string, source: ReadableStream<Uint8Array>, request: StoreRequest): Promise<PutBlobResult> {
  request.progress?.start();
  const store = await getBlobStore();
  const existing = await store.info(name);
  const live = existing && !existing.deleted ? existing : null;

  if (request.ifMatch !== undefined) {
    if (!live || etagOf(live) !== request.ifMatch) throw new BlobPreconditionFailedError();
  } else if (live && !request.allowOverwrite) {
    throw new BlobAlreadyExistsError();
  }

  let stream = limitSize(source, request.maximumSizeInBytes);
  if (request.progress) {
    const progress = request.progress;
    let loaded = 0;
    stream = stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          loaded += chunk.length;
          progress.advance(loaded);
          controller.enqueue(chunk);
        },
      }),
    );
  }
  if (request.abortSignal) {
    stream = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: request.abortSignal });
  }

  const metadata: Record<string, string> = {
    contentType: request.contentType ?? inferContentType(name),
    access: request.access,
    contentDisposition: dispositionFor(name),
  };
  if (request.cacheControlMaxAge !== undefined) metadata.cacheControl = `public, max-age=${request.cacheControlMaxAge}`;

  const info = await aborting(request.abortSignal, () =>
    store
      .put({ name, metadata }, stream, {
        previousRevision: request.ifMatch !== undefined || !request.allowOverwrite ? (existing?.revision ?? 0) : undefined,
      })
      .catch((err: unknown) => {
        if (err instanceof Error && /wrong last sequence/i.test(err.message)) throw new BlobAlreadyExistsError();
        throw err;
      }),
  );
  request.progress?.finish();
  return resultOf(info);
}

function resultOf(info: ObjectInfo): PutBlobResult {
  const d = describe(info);
  return {
    url: d.url,
    downloadUrl: d.downloadUrl,
    pathname: d.pathname,
    contentType: d.contentType,
    contentDisposition: d.contentDisposition,
    etag: d.etag,
  };
}

function contentTypeOf(name: string, explicit: string | undefined): string {
  return explicit || inferContentType(name);
}

export async function put(pathname: string, body: PutBody | null, options: PutCommandOptions): Promise<PutBlobResult> {
  assertBody(body);
  assertPathname(pathname);
  assertAccess(options);
  assertConsistentIfMatch(options);
  if (options.optimizeImage) throw unsupportedImageOptimization();
  assertNotAborted(options.abortSignal);
  const name = options.addRandomSuffix ? withSuffix(pathname) : pathname;
  const length = bodyLength(body as PutBody);
  const contentType = contentTypeOf(name, options.contentType);

  if (options.multipart) {
    const progress = multipartProgress(options.onUploadProgress, length);
    progress.start();
    const uploader = await createMultipartUploader(name, { ...options, addRandomSuffix: false, contentType });
    const parts: Part[] = [];
    let loaded = 0;
    let partNumber = 0;
    for await (const piece of chunked(toStream(body as PutBody), PART_SIZE)) {
      parts.push(await uploader.uploadPart(++partNumber, piece));
      loaded += piece.length;
      progress.advance(loaded);
    }
    return uploader.complete(parts);
  }

  return storeStream(name, toStream(body as PutBody), {
    access: options.access,
    contentType,
    cacheControlMaxAge: options.cacheControlMaxAge,
    allowOverwrite: options.allowOverwrite,
    ifMatch: options.ifMatch,
    maximumSizeInBytes: options.maximumSizeInBytes,
    progress: options.onUploadProgress ? uploadProgress(options.onUploadProgress, length) : undefined,
    abortSignal: options.abortSignal,
  });
}

export async function putImage(_pathname: string, _bodyOrUrl: PutBody | URL, _options: PutImageCommandOptions): Promise<PutImageBlobResult> {
  throw unsupportedImageOptimization();
}

export async function putFromUrl(_pathname: string, _url: string, _options: PutFromUrlCommandOptions): Promise<PutFromUrlBlobResult> {
  throw unsupportedImageOptimization();
}

interface UploadRecord {
  key: string;
  access: BlobAccessType;
  contentType?: string;
  cacheControlMaxAge?: number;
  allowOverwrite?: boolean;
  ifMatch?: string;
  maximumSizeInBytes?: number;
}

const metaName = (uploadId: string) => `${uploadId}/meta`;
const partName = (uploadId: string, partNumber: number) => `${uploadId}/${partNumber}`;

async function loadUpload(uploadId: string, key: string): Promise<UploadRecord> {
  const store = await getUploadStore();
  const stored = uploadId ? await store.get(metaName(uploadId)) : null;
  if (!stored) throw new BlobError("Unknown multipart upload, it may have expired", { reason: "UPLOAD_NOT_FOUND", subject: "/uploadId" });
  const record = JSON.parse(await new Response(stored.data).text()) as UploadRecord;
  if (record.key !== key) throw new BlobError("key does not match the multipart upload", { reason: "UPLOAD_KEY_MISMATCH", subject: "/key" });
  return record;
}

export async function createMultipartUpload(
  pathname: string,
  options: CommonCreateBlobOptions,
): Promise<{ key: string; uploadId: string }> {
  assertPathname(pathname);
  assertAccess(options);
  assertNotAborted(options.abortSignal);
  const key = options.addRandomSuffix ? withSuffix(pathname) : pathname;
  const uploadId = globalThis.crypto.randomUUID();
  const record: UploadRecord = {
    key,
    access: options.access,
    contentType: options.contentType,
    cacheControlMaxAge: options.cacheControlMaxAge,
    allowOverwrite: options.allowOverwrite,
    ifMatch: options.ifMatch,
    maximumSizeInBytes: options.maximumSizeInBytes,
  };
  await (await getUploadStore()).putBlob({ name: metaName(uploadId) }, new TextEncoder().encode(JSON.stringify(record)));
  return { key, uploadId };
}

export async function uploadPart(pathname: string, body: PutBody, options: UploadPartCommandOptions): Promise<Part> {
  assertPathname(pathname);
  assertAccess(options);
  assertNotAborted(options.abortSignal);
  if (!Number.isInteger(options.partNumber) || options.partNumber < 1 || options.partNumber > MAX_PARTS) {
    throw new BlobError(`partNumber must be an integer between 1 and ${MAX_PARTS}`, { reason: "INVALID_PART_NUMBER", subject: "/partNumber" });
  }
  await loadUpload(options.uploadId, options.key);
  const store = await getUploadStore();
  const info = await aborting(options.abortSignal, () =>
    store.put({ name: partName(options.uploadId, options.partNumber) }, toStream(body)),
  );
  return { etag: etagOf(info), partNumber: options.partNumber };
}

export async function completeMultipartUpload(
  pathname: string,
  parts: Part[],
  options: CompleteMultipartUploadCommandOptions,
): Promise<PutBlobResult> {
  assertPathname(pathname);
  assertAccess(options);
  assertNotAborted(options.abortSignal);
  const record = await loadUpload(options.uploadId, options.key);
  if (parts.length === 0) throw new BlobError("parts must not be empty", { reason: "INVALID_PARTS", subject: "/parts" });
  const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const store = await getUploadStore();
  const infos: ObjectInfo[] = [];
  for (const part of ordered) {
    const info = await store.info(partName(options.uploadId, part.partNumber));
    if (!info || info.deleted || etagOf(info) !== part.etag) {
      throw new BlobError(`Part ${part.partNumber} was not uploaded or its etag does not match`, {
        reason: "INVALID_PART",
        subject: "/parts",
      });
    }
    infos.push(info);
  }

  const joined = concat(
    infos.map((info) => async () => {
      const part = await store.get(info.name);
      if (!part) throw new BlobNotFoundError();
      return part.data;
    }),
  );
  const result = await storeStream(record.key, joined, {
    access: options.access ?? record.access,
    contentType: options.contentType ?? record.contentType,
    cacheControlMaxAge: options.cacheControlMaxAge ?? record.cacheControlMaxAge,
    allowOverwrite: options.allowOverwrite ?? record.allowOverwrite,
    ifMatch: options.ifMatch ?? record.ifMatch,
    maximumSizeInBytes: options.maximumSizeInBytes ?? record.maximumSizeInBytes,
    abortSignal: options.abortSignal,
  });
  await Promise.all([...infos.map((info) => store.delete(info.name)), store.delete(metaName(options.uploadId))]).catch(() => undefined);
  return result;
}

export async function createMultipartUploader(pathname: string, options: CommonCreateBlobOptions) {
  const { key, uploadId } = await createMultipartUpload(pathname, options);
  return {
    key,
    uploadId,
    uploadPart: (partNumber: number, body: PutBody): Promise<Part> =>
      uploadPart(pathname, body, { ...options, key, uploadId, partNumber }),
    complete: (parts: Part[]): Promise<PutBlobResult> => completeMultipartUpload(pathname, parts, { ...options, key, uploadId }),
  };
}

export async function createFolder(pathname: string, options: CreateFolderCommandOptions = {}): Promise<CreateFolderResult> {
  const folder = pathname.endsWith("/") ? pathname : `${pathname}/`;
  assertPathname(folder, true);
  assertNotAborted(options.abortSignal);
  const store = await getBlobStore();
  if (!(await statBlob(folder, store))) {
    await store.putBlob({ name: folder, metadata: { access: options.access ?? "public", contentType: "application/x-directory" } }, new Uint8Array());
  }
  return { pathname: folder, url: blobUrl(folder) };
}

export async function head(urlOrPathname: string, options?: BlobCommandOptions): Promise<HeadBlobResult> {
  assertNotAborted(options?.abortSignal);
  const info = await statBlob(resolvePathname(urlOrPathname));
  if (!info) throw new BlobNotFoundError();
  const d = describe(info);
  return {
    size: d.size,
    uploadedAt: d.uploadedAt,
    pathname: d.pathname,
    contentType: d.contentType,
    contentDisposition: d.contentDisposition,
    url: d.url,
    downloadUrl: d.downloadUrl,
    cacheControl: d.cacheControl,
    etag: d.etag,
  };
}

export async function get(urlOrPathname: string, options: GetCommandOptions): Promise<GetBlobResult | null> {
  if (!urlOrPathname) throw new BlobError("url or pathname is required");
  assertAccess(options);
  let given: URL | undefined;
  if (isHttpUrl(urlOrPathname)) {
    try {
      given = new URL(urlOrPathname);
    } catch {
      throw new BlobError("Invalid URL: unable to parse the provided URL");
    }
    if (!isAllowedBlobUrl(given)) {
      throw new BlobError(
        "Invalid URL: the URL does not point to a Vercel Blob store. Use a pathname instead, see https://vercel.com/docs/vercel-blob",
      );
    }
  }
  if (options.abortSignal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
  const store = await getBlobStore();
  const info = await statBlob(resolvePathname(urlOrPathname), store);
  if (!info) return null;
  const d = describe(info);
  if (!given && options.access !== d.access) return null;
  const downloading = given?.searchParams.has("download") ?? false;
  const contentDisposition = downloading ? d.contentDisposition.replace(/^inline/, "attachment") : d.contentDisposition;
  const downloadUrl = given ? new URL(given) : undefined;
  downloadUrl?.searchParams.set("download", "1");
  const base: GetBlobResultBlobBase = {
    url: given ? urlOrPathname : d.url,
    downloadUrl: downloadUrl?.toString() ?? d.downloadUrl,
    pathname: given ? rawPathnameOfUrl(given) : urlOrPathname,
    contentDisposition,
    cacheControl: d.cacheControl,
    uploadedAt: d.uploadedAt,
    etag: d.etag,
  };
  const headers = new Headers({
    ETag: d.etag,
    "Cache-Control": d.cacheControl,
    "Content-Disposition": contentDisposition,
    "Last-Modified": d.uploadedAt.toUTCString(),
  });
  if (options.ifNoneMatch && matchesEtag(options.ifNoneMatch, d.etag)) {
    return { statusCode: 304, stream: null, headers, blob: { ...base, contentType: null, size: null } };
  }
  const result = await store.get(info.name);
  if (!result) return null;
  headers.set("Content-Type", d.contentType);
  headers.set("Content-Length", String(info.size));
  return { statusCode: 200, stream: result.data, headers, blob: { ...base, contentType: d.contentType, size: d.size } };
}

export function matchesEtag(header: string, etag: string): boolean {
  return header
    .split(",")
    .map((v) => v.trim().replace(/^W\//, ""))
    .some((v) => v === "*" || v === etag);
}

export async function del(urlOrPathname: string | string[], options?: DeleteCommandOptions): Promise<void> {
  assertNotAborted(options?.abortSignal);
  const store = await getBlobStore();
  const targets = Array.isArray(urlOrPathname) ? urlOrPathname : [urlOrPathname];
  if (options?.ifMatch && targets.length > 1) throw new BlobError("ifMatch can only be used when deleting a single URL.");
  for (const target of targets) {
    const pathname = resolvePathname(target);
    if (options?.ifMatch !== undefined) {
      const info = await statBlob(pathname, store);
      if (!info || etagOf(info) !== options.ifMatch) throw new BlobPreconditionFailedError();
    }
    await store.delete(pathname);
  }
}

export async function list<M extends "expanded" | "folded" | undefined = undefined>(
  options: ListCommandOptions<M> = {},
): Promise<ListCommandResult<M>> {
  assertNotAborted(options.abortSignal);
  const store = await getBlobStore();
  const limit = options.limit ? Math.min(Math.max(options.limit, 1), 1000) : 1000;
  const prefix = options.prefix ?? "";
  const infos = (await store.list()).filter((i) => !i.deleted && i.name.startsWith(prefix));
  const folded = options.mode === "folded";

  type Entry = { key: string; info?: ObjectInfo; folder?: string };
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const info of infos) {
    if (folded) {
      const rest = info.name.slice(prefix.length);
      if (rest === "") continue;
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        const folder = `${prefix}${rest.slice(0, slash + 1)}`;
        if (!seen.has(folder)) {
          seen.add(folder);
          entries.push({ key: folder, folder });
        }
        continue;
      }
    }
    entries.push({ key: info.name, info });
  }
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const after = options.cursor ? Buffer.from(options.cursor, "base64url").toString() : undefined;
  const remaining = after === undefined ? entries : entries.filter((e) => e.key > after);
  const page = remaining.slice(0, limit);
  const hasMore = remaining.length > limit;

  const blobs = page
    .filter((e) => e.info)
    .map((e) => {
      const d = describe(e.info!);
      return { url: d.url, downloadUrl: d.downloadUrl, pathname: d.pathname, size: d.size, uploadedAt: d.uploadedAt, etag: d.etag };
    });
  const result: ListBlobResult = {
    blobs,
    hasMore,
    ...(hasMore && { cursor: Buffer.from(page[page.length - 1]!.key).toString("base64url") }),
  };
  if (folded) (result as ListFoldedBlobResult).folders = page.filter((e) => e.folder).map((e) => e.folder!);
  return result as ListCommandResult<M>;
}

export async function copy(fromUrlOrPathname: string, toPathname: string, options: CopyCommandOptions): Promise<CopyBlobResult> {
  assertAccess(options);
  assertPathname(toPathname);
  assertNotAborted(options.abortSignal);
  const store = await getBlobStore();
  const info = await statBlob(resolvePathname(fromUrlOrPathname), store);
  const source = info ? await store.get(info.name) : null;
  if (!info || !source) throw new BlobNotFoundError();
  const name = options.addRandomSuffix ? withSuffix(toPathname) : toPathname;
  return storeStream(name, source.data, {
    access: options.access,
    contentType: options.contentType ?? describe(info).contentType,
    cacheControlMaxAge: options.cacheControlMaxAge,
    allowOverwrite: options.allowOverwrite,
    ifMatch: options.ifMatch,
    maximumSizeInBytes: options.maximumSizeInBytes,
    abortSignal: options.abortSignal,
  });
}

export async function rename(fromUrlOrPathname: string, toPathname: string, options: RenameCommandOptions): Promise<RenameBlobResult> {
  const result = await copy(fromUrlOrPathname, toPathname, options);
  await del(fromUrlOrPathname);
  return result;
}
