import "server-only";
import type { ObjectInfo, ObjectStore } from "@nats-io/obj";
import { getObjm } from "../connection.js";
import { getBlobConfig } from "./config.js";
import { limitSize, inferContentType, sliceStream, toStream, type PutBody } from "./body.js";
import { BlobError, BlobNotFoundError, BlobPreconditionFailedError } from "./errors.js";

export type BlobAccessType = "public" | "private";

export interface BlobCommandOptions {
  token?: string;
  abortSignal?: AbortSignal;
}

export interface PutCommandOptions extends BlobCommandOptions {
  access: BlobAccessType;
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
  contentType?: string;
  cacheControlMaxAge?: number;
  ifMatch?: string;
  maximumSizeInBytes?: number;
  multipart?: boolean;
  onUploadProgress?: (event: { loaded: number; total: number; percentage: number }) => void;
}

export interface PutBlobResult {
  url: string;
  downloadUrl: string;
  pathname: string;
  contentType: string;
  contentDisposition: string;
  etag: string;
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
  access?: BlobAccessType;
  ifNoneMatch?: string;
  range?: { start: number; end?: number };
}

export interface GetBlobResultBlob {
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
      blob: GetBlobResultBlob & { contentType: string; size: number };
    }
  | {
      statusCode: 304;
      stream: null;
      headers: Headers;
      blob: GetBlobResultBlob & { contentType: null; size: null };
    };

export interface CopyBlobResult extends PutBlobResult {}

const STORES = Symbol.for("next-nats.blob.stores");

function stores(): Map<string, Promise<ObjectStore>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<ObjectStore>> | undefined>;
  return (g[STORES] ??= new Map());
}

export function getBlobStore(bucket = getBlobConfig().bucket): Promise<ObjectStore> {
  const cache = stores();
  let store = cache.get(bucket);
  if (!store) {
    store = getObjm().then((objm) => objm.create(bucket));
    cache.set(bucket, store);
    store.catch(() => cache.delete(bucket));
  }
  return store;
}

export function blobUrl(pathname: string): string {
  const base = getBlobConfig().baseUrl.replace(/\/+$/, "");
  return `${base}/${pathname.split("/").map(encodeURIComponent).join("/")}`;
}

export function blobDownloadUrl(pathname: string): string {
  return `${blobUrl(pathname)}?download=1`;
}

export function resolvePathname(urlOrPathname: string): string {
  const base = getBlobConfig().baseUrl.replace(/\/+$/, "");
  let candidate = urlOrPathname;
  if (/^https?:\/\//i.test(candidate)) {
    const parsed = new URL(candidate);
    candidate = parsed.pathname;
    const basePath = /^https?:\/\//i.test(base) ? new URL(base).pathname.replace(/\/+$/, "") : base;
    if (basePath && candidate.startsWith(`${basePath}/`)) candidate = candidate.slice(basePath.length);
    return decodeURIComponent(candidate).replace(/^\/+/, "");
  }
  if (base && candidate.startsWith(`${base}/`)) {
    return decodeURIComponent(candidate.slice(base.length)).replace(/^\/+/, "");
  }
  return candidate.replace(/^\/+/, "");
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

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 12).padEnd(10, "0");
}

function withSuffix(pathname: string): string {
  const slash = pathname.lastIndexOf("/");
  const dot = pathname.lastIndexOf(".");
  if (dot > slash + 1) return `${pathname.slice(0, dot)}-${randomSuffix()}${pathname.slice(dot)}`;
  return `${pathname}-${randomSuffix()}`;
}

function assertPathname(pathname: string): void {
  if (!pathname || pathname.length > 1024) throw new BlobError("pathname is required and must be 1024 characters or fewer");
  if (pathname.endsWith("/")) throw new BlobError("pathname cannot end with a slash");
}

export async function put(pathname: string, body: PutBody | null, options: PutCommandOptions): Promise<PutBlobResult> {
  assertPathname(pathname);
  if (!options || (options.access !== "public" && options.access !== "private")) {
    throw new BlobError('access must be "public" or "private"');
  }
  if (body === null || body === undefined) throw new BlobError("body is required");
  const store = await getBlobStore();
  const name = options.addRandomSuffix ? withSuffix(pathname) : pathname;
  const existing = await store.info(name);
  const live = existing && !existing.deleted ? existing : null;

  if (options.ifMatch !== undefined) {
    if (!live || etagOf(live) !== options.ifMatch) throw new BlobPreconditionFailedError();
  } else if (live && !options.allowOverwrite) {
    throw new BlobError("This blob already exists, use `allowOverwrite: true` to overwrite it");
  }

  const contentType =
    options.contentType ?? (typeof Blob !== "undefined" && body instanceof Blob && body.type ? body.type : inferContentType(name));
  const total = typeof Blob !== "undefined" && body instanceof Blob ? body.size : undefined;
  let stream = limitSize(toStream(body), options.maximumSizeInBytes);
  if (options.onUploadProgress) {
    let loaded = 0;
    const report = options.onUploadProgress;
    stream = stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          loaded += chunk.length;
          const known = total ?? loaded;
          report({ loaded, total: known, percentage: known ? Math.round((loaded / known) * 100) : 100 });
          controller.enqueue(chunk);
        },
      }),
    );
  }
  if (options.abortSignal) {
    const signal = options.abortSignal;
    stream = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal });
  }

  const metadata: Record<string, string> = { contentType, access: options.access };
  metadata.contentDisposition = dispositionFor(name);
  if (options.cacheControlMaxAge !== undefined) {
    metadata.cacheControl = `public, max-age=${options.cacheControlMaxAge}`;
  }

  const info = await store.put({ name, metadata }, stream, { previousRevision: options.ifMatch !== undefined || !options.allowOverwrite ? (existing?.revision ?? 0) : undefined }).catch((err: unknown) => {
    if (err instanceof Error && /wrong last sequence/i.test(err.message)) {
      throw new BlobError("This blob already exists, use `allowOverwrite: true` to overwrite it");
    }
    throw err;
  });
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

export async function head(urlOrPathname: string, _options?: BlobCommandOptions): Promise<HeadBlobResult> {
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

export async function get(urlOrPathname: string, options: GetCommandOptions = {}): Promise<GetBlobResult | null> {
  const store = await getBlobStore();
  const info = await statBlob(resolvePathname(urlOrPathname), store);
  if (!info) return null;
  const d = describe(info);
  const base: GetBlobResultBlob = {
    url: d.url,
    downloadUrl: d.downloadUrl,
    pathname: d.pathname,
    contentDisposition: d.contentDisposition,
    cacheControl: d.cacheControl,
    uploadedAt: d.uploadedAt,
    etag: d.etag,
  };
  const headers = new Headers({ ETag: d.etag, "Cache-Control": d.cacheControl, "Content-Disposition": d.contentDisposition });
  if (options.ifNoneMatch && matchesEtag(options.ifNoneMatch, d.etag)) {
    return { statusCode: 304, stream: null, headers, blob: { ...base, contentType: null, size: null } };
  }
  const result = await store.get(info.name);
  if (!result) return null;
  headers.set("Content-Type", d.contentType);
  let stream = result.data;
  if (options.range) {
    const end = Math.min(options.range.end ?? info.size - 1, info.size - 1);
    stream = sliceStream(stream, options.range.start, end);
    headers.set("Content-Length", String(end - options.range.start + 1));
  } else {
    headers.set("Content-Length", String(info.size));
  }
  return { statusCode: 200, stream, headers, blob: { ...base, contentType: d.contentType, size: d.size } };
}

export function matchesEtag(header: string, etag: string): boolean {
  return header
    .split(",")
    .map((v) => v.trim().replace(/^W\//, ""))
    .some((v) => v === "*" || v === etag);
}

export async function del(urlOrPathname: string | string[], _options?: BlobCommandOptions & { ifMatch?: string }): Promise<void> {
  const store = await getBlobStore();
  const targets = Array.isArray(urlOrPathname) ? urlOrPathname : [urlOrPathname];
  for (const target of targets) {
    const pathname = resolvePathname(target);
    if (_options?.ifMatch !== undefined) {
      const info = await statBlob(pathname, store);
      if (!info || etagOf(info) !== _options.ifMatch) throw new BlobPreconditionFailedError();
    }
    await store.delete(pathname);
  }
}

export async function list<M extends "expanded" | "folded" | undefined = undefined>(
  options: ListCommandOptions<M> = {},
): Promise<ListCommandResult<M>> {
  const store = await getBlobStore();
  const limit = Math.min(Math.max(options.limit ?? 1000, 1), 1000);
  const prefix = options.prefix ?? "";
  const infos = (await store.list()).filter((i) => !i.deleted && i.name.startsWith(prefix));
  const folded = options.mode === "folded";

  type Entry = { key: string; info?: ObjectInfo; folder?: string };
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const info of infos) {
    if (folded) {
      const rest = info.name.slice(prefix.length);
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

export async function copy(fromUrlOrPathname: string, toPathname: string, options: PutCommandOptions): Promise<CopyBlobResult> {
  const source = await get(fromUrlOrPathname);
  if (!source || source.statusCode !== 200) throw new BlobNotFoundError();
  return put(toPathname, source.stream, {
    ...options,
    contentType: options.contentType ?? source.blob.contentType,
  });
}

export async function rename(fromUrlOrPathname: string, toPathname: string, options: PutCommandOptions): Promise<CopyBlobResult> {
  const result = await copy(fromUrlOrPathname, toPathname, options);
  await del(fromUrlOrPathname);
  return result;
}
