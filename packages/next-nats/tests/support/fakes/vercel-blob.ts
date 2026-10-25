import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local stand-in for the Vercel Blob HTTP API.
 *
 * Every endpoint, header, query parameter and body shape below was read out of the shipped
 * `@vercel/blob@2.8.2` sources:
 *   - dist/chunk-XKVPKJPO.js: api base url (`VERCEL_BLOB_API_URL`), token parsing, `requestApi`
 *     headers, error code mapping (`getBlobError`), put headers, `/mpu`, `/signed-token`, createFolder
 *   - dist/index.js: `/delete`, `?url=` (head), list query, copy (`fromUrl`), `/rename`, get (direct url fetch)
 *   - dist/client.js: client token layout, `handleUpload` callback signature, event bodies
 * Anything the SDK does not reveal is marked `ASSUMPTION` and listed in docs/explanations/known-gaps.md.
 */

export const API_PATH = "/api/blob";
export const DEFAULT_STORE_ID = "teststore";
const CLIENT_TOKEN_PREFIX = "vercel_blob_client_";

interface StoredBlob {
  pathname: string;
  bytes: Buffer;
  contentType: string;
  contentDisposition: string;
  cacheControl: string;
  access: "public" | "private";
  uploadedAt: Date;
  etag: string;
}

interface UploadSession {
  key: string;
  access: "public" | "private";
  contentType: string;
  parts: Map<number, { bytes: Buffer; etag: string }>;
  policy: Policy;
}

interface Policy {
  addRandomSuffix: boolean;
  allowOverwrite: boolean;
  cacheControlMaxAge: number;
  ifMatch?: string;
  maximumSizeInBytes?: number;
  allowedContentTypes?: string[];
  callback?: { callbackUrl: string; tokenPayload?: string | null };
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}

export interface DeliveredCallback {
  url: string;
  body: string;
  signature: string;
  status: number | "error";
}

export interface FakeVercelBlob {
  readonly origin: string;
  readonly apiUrl: string;
  readonly storeId: string;
  readonly readWriteToken: string;
  readonly requests: RecordedRequest[];
  readonly callbacks: DeliveredCallback[];
  readonly blobCount: () => number;
  reset(): void;
  close(): Promise<void>;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  xml: "application/xml",
  pdf: "application/pdf",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  woff2: "font/woff2",
};

const SUFFIX_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomSuffix(): string {
  // ASSUMPTION: the SDK does not reveal the shape of the random suffix. Vercel documents 30 alphanumerics.
  const bytes = randomBytes(30);
  return Array.from(bytes, (b) => SUFFIX_ALPHABET[b % SUFFIX_ALPHABET.length]).join("");
}

function withSuffix(pathname: string): string {
  const slash = pathname.lastIndexOf("/");
  const dot = pathname.lastIndexOf(".");
  if (dot > slash + 1) return `${pathname.slice(0, dot)}-${randomSuffix()}${pathname.slice(dot)}`;
  return `${pathname}-${randomSuffix()}`;
}

function inferContentType(pathname: string): string | undefined {
  const base = pathname.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return MIME[base.slice(dot + 1).toLowerCase()];
}

function etagOf(bytes: Buffer): string {
  // ASSUMPTION: the SDK treats etags as opaque. A quoted content hash is used; the real service may differ.
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

function hmacHex(key: string, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

function encodeUrlPath(pathname: string): string {
  return pathname.split("/").map(encodeURIComponent).join("/");
}

function flag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "1" || value === "true";
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function startFakeVercelBlob(options: { storeId?: string } = {}): Promise<FakeVercelBlob> {
  const storeId = options.storeId ?? DEFAULT_STORE_ID;
  const readWriteToken = `vercel_blob_rw_${storeId}_${randomBytes(12).toString("hex")}`;
  const blobs = new Map<string, StoredBlob>();
  const uploads = new Map<string, UploadSession>();
  const requests: RecordedRequest[] = [];
  const callbacks: DeliveredCallback[] = [];
  let origin = "";

  const urlFor = (pathname: string) => `${origin}/${encodeUrlPath(pathname)}`;
  const downloadUrlFor = (pathname: string) => `${urlFor(pathname)}?download=1`;

  function resolvePathname(urlOrPathname: string): string {
    // ASSUMPTION: a url is mapped back to a pathname by its path alone; a bare string is taken as a pathname.
    if (/^https?:\/\//i.test(urlOrPathname)) {
      const parsed = new URL(urlOrPathname);
      return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    }
    return urlOrPathname;
  }

  function putResult(blob: StoredBlob) {
    return {
      url: urlFor(blob.pathname),
      downloadUrl: downloadUrlFor(blob.pathname),
      pathname: blob.pathname,
      contentType: blob.contentType,
      contentDisposition: blob.contentDisposition,
      etag: blob.etag,
    };
  }

  function dispositionFor(pathname: string, attachment = false): string {
    // ASSUMPTION: filename is the last path segment, inline unless downloading.
    const name = (pathname.split("/").pop() ?? pathname).replace(/"/g, "");
    return `${attachment ? "attachment" : "inline"}; filename="${name}"`;
  }

  interface Principal {
    kind: "readWrite" | "client";
    policy?: Policy;
    pathname?: string;
  }

  function authenticate(req: IncomingMessage): Principal {
    const authorization = header(req, "authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!token) throw new ApiError(403, "forbidden", "Access denied");
    const parts = token.split("_");
    const tokenStore = parts[3];
    const storeHeader = header(req, "x-vercel-blob-store-id");
    if (storeHeader !== undefined && storeHeader !== storeId) throw new ApiError(404, "store_not_found", "This store does not exist");
    if (tokenStore !== storeId) throw new ApiError(403, "forbidden", "Access denied");
    if (token.startsWith("vercel_blob_rw_")) {
      if (token !== readWriteToken) throw new ApiError(403, "forbidden", "Access denied");
      return { kind: "readWrite" };
    }
    if (token.startsWith(CLIENT_TOKEN_PREFIX)) {
      // client.js generateClientTokenFromReadWriteToken: `${prefix}${storeId}_${base64(`${hmacHex(rw, payload)}.${payload}`)}`
      const encoded = token.slice(`${CLIENT_TOKEN_PREFIX}${storeId}_`.length);
      const decoded = Buffer.from(encoded, "base64").toString();
      const dot = decoded.indexOf(".");
      const signature = decoded.slice(0, dot);
      const payloadB64 = decoded.slice(dot + 1);
      if (dot < 0 || signature !== hmacHex(readWriteToken, payloadB64)) throw new ApiError(403, "forbidden", "Access denied");
      const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString()) as {
        pathname: string;
        validUntil: number;
        addRandomSuffix?: boolean;
        allowOverwrite?: boolean;
        cacheControlMaxAge?: number;
        ifMatch?: string;
        maximumSizeInBytes?: number;
        allowedContentTypes?: string[];
        onUploadCompleted?: { callbackUrl: string; tokenPayload?: string | null };
      };
      // The message "Token expired" is matched verbatim by the SDK (getBlobError).
      if (payload.validUntil < Date.now()) throw new ApiError(401, "forbidden", "Token expired");
      return {
        kind: "client",
        pathname: payload.pathname,
        policy: {
          addRandomSuffix: payload.addRandomSuffix ?? false,
          allowOverwrite: payload.allowOverwrite ?? false,
          // ASSUMPTION: default cache max age is one month (2592000 seconds).
          cacheControlMaxAge: payload.cacheControlMaxAge ?? 2592000,
          ifMatch: payload.ifMatch,
          maximumSizeInBytes: payload.maximumSizeInBytes,
          allowedContentTypes: payload.allowedContentTypes,
          callback: payload.onUploadCompleted,
        },
      };
    }
    throw new ApiError(403, "forbidden", "Access denied");
  }

  function requireReadWrite(principal: Principal): void {
    if (principal.kind === "client") {
      throw new ApiError(
        403,
        "client_token_not_allowed",
        "This operation is not available when using a client token. Use a read–write or OIDC token on the server.",
      );
    }
  }

  function policyFromHeaders(req: IncomingMessage, principal: Principal): Policy {
    if (principal.policy) return principal.policy;
    // ASSUMPTION: addRandomSuffix defaults to false and allowOverwrite to false (SDK 2.x defaults).
    return {
      addRandomSuffix: flag(header(req, "x-add-random-suffix")) ?? false,
      allowOverwrite: flag(header(req, "x-allow-overwrite")) ?? false,
      cacheControlMaxAge: Number(header(req, "x-cache-control-max-age") ?? 2592000),
      ifMatch: header(req, "x-if-match"),
    };
  }

  function assertTokenScope(principal: Principal, pathname: string): void {
    if (principal.kind !== "client") return;
    if (principal.pathname !== pathname) {
      // The SDK matches '"pathname"' and 'does not match the token payload' in the message.
      throw new ApiError(
        403,
        "forbidden",
        `The "pathname" ${JSON.stringify(pathname)} does not match the token payload ${JSON.stringify(principal.pathname)}`,
      );
    }
  }

  function assertContentType(policy: Policy, contentType: string): void {
    const allowed = policy.allowedContentTypes;
    if (!allowed?.length) return;
    const type = contentType.split(";")[0]!.trim().toLowerCase();
    const [group] = type.split("/");
    if (allowed.some((a) => a.toLowerCase() === type || a.toLowerCase() === `${group}/*`)) return;
    // The SDK matches 'contentType' and 'is not allowed' in the message.
    throw new ApiError(403, "forbidden", `The provided contentType "${contentType}" is not allowed`);
  }

  function assertSize(policy: Policy, size: number): void {
    if (policy.maximumSizeInBytes !== undefined && size > policy.maximumSizeInBytes) {
      // The SDK matches 'the file length cannot be greater than' in the message.
      throw new ApiError(403, "forbidden", `Upload rejected, the file length cannot be greater than ${policy.maximumSizeInBytes} bytes`);
    }
  }

  function resolveContentType(explicit: string | undefined, pathname: string): string {
    // ASSUMPTION: precedence is x-content-type, then the pathname extension, then application/octet-stream.
    // The request Content-Type is ignored: the SDK only forwards the caller's type as x-content-type, and
    // its docs say the default is derived from the pathname extension.
    return explicit ?? inferContentType(pathname) ?? "application/octet-stream";
  }

  function commit(
    pathname: string,
    bytes: Buffer,
    meta: { contentType: string; access: "public" | "private"; cacheControlMaxAge: number },
    policy: Policy,
  ): StoredBlob {
    const key = policy.addRandomSuffix ? withSuffix(pathname) : pathname;
    return commitKey(key, bytes, meta, policy);
  }

  function commitKey(
    key: string,
    bytes: Buffer,
    meta: { contentType: string; access: "public" | "private"; cacheControlMaxAge: number },
    policy: Policy,
  ): StoredBlob {
    const existing = blobs.get(key);
    if (policy.ifMatch !== undefined) {
      // ASSUMPTION: a conditional write against a missing blob fails the precondition.
      if (!existing || existing.etag !== policy.ifMatch) throw new ApiError(412, "precondition_failed", "Precondition failed");
    } else if (existing && !policy.allowOverwrite) {
      // ASSUMPTION: the status code and message are not revealed; the SDK maps `bad_request` to BlobError(message).
      throw new ApiError(400, "bad_request", "This blob already exists, use `allowOverwrite: true` to overwrite it");
    }
    const blob: StoredBlob = {
      pathname: key,
      bytes,
      contentType: meta.contentType,
      contentDisposition: dispositionFor(key),
      // ASSUMPTION: cacheControl is rendered as `public, max-age=<seconds>`.
      cacheControl: `public, max-age=${meta.cacheControlMaxAge}`,
      access: meta.access,
      uploadedAt: new Date(),
      etag: etagOf(bytes),
    };
    blobs.set(key, blob);
    return blob;
  }

  function notifyUploadCompleted(policy: Policy, blob: StoredBlob): void {
    const target = policy.callback;
    if (!target) return;
    // ASSUMPTION: the callback is fired after the upload response, not before it.
    // Body and signature follow handleUpload's verification (client.js): hmac-sha256 hex of the JSON body, keyed by the rw token.
    const body = JSON.stringify({
      type: "blob.upload-completed",
      payload: { blob: putResult(blob), tokenPayload: target.tokenPayload ?? null },
    });
    const signature = hmacHex(readWriteToken, body);
    setImmediate(() => {
      fetch(target.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vercel-signature": signature },
        body,
      })
        .then((res) => callbacks.push({ url: target.callbackUrl, body, signature, status: res.status }))
        .catch(() => callbacks.push({ url: target.callbackUrl, body, signature, status: "error" }));
    });
  }

  function listEntry(blob: StoredBlob) {
    return {
      url: urlFor(blob.pathname),
      downloadUrl: downloadUrlFor(blob.pathname),
      pathname: blob.pathname,
      size: blob.bytes.length,
      uploadedAt: blob.uploadedAt.toISOString(),
      etag: blob.etag,
    };
  }

  function handleList(query: URLSearchParams) {
    // ASSUMPTION: limit defaults to 1000 (the maximum), ordering is lexicographic by pathname, the cursor is opaque,
    // and in folded mode folders and blobs share the page limit.
    const limit = Math.min(Math.max(Number(query.get("limit") ?? 1000) || 1000, 1), 1000);
    const prefix = query.get("prefix") ?? "";
    const folded = query.get("mode") === "folded";
    type Entry = { key: string; blob?: StoredBlob; folder?: string };
    const entries: Entry[] = [];
    const seen = new Set<string>();
    for (const blob of blobs.values()) {
      if (!blob.pathname.startsWith(prefix)) continue;
      if (folded) {
        const rest = blob.pathname.slice(prefix.length);
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
      entries.push({ key: blob.pathname, blob });
    }
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const cursor = query.get("cursor");
    const after = cursor ? Buffer.from(cursor, "base64url").toString() : undefined;
    const remaining = after === undefined ? entries : entries.filter((e) => e.key > after);
    const page = remaining.slice(0, limit);
    const hasMore = remaining.length > limit;
    return {
      blobs: page.filter((e) => e.blob).map((e) => listEntry(e.blob!)),
      ...(folded && { folders: page.filter((e) => e.folder).map((e) => e.folder!) }),
      hasMore,
      ...(hasMore && { cursor: Buffer.from(page[page.length - 1]!.key).toString("base64url") }),
    };
  }

  function copyBlob(req: IncomingMessage, principal: Principal, query: URLSearchParams, rename: boolean) {
    requireReadWrite(principal);
    const toPathname = query.get("pathname") ?? "";
    const from = resolvePathname(query.get("fromUrl") ?? "");
    const source = blobs.get(from);
    if (!source) throw new ApiError(404, "not_found", "The requested blob does not exist");
    const policy = policyFromHeaders(req, principal);
    const access = header(req, "x-vercel-blob-access") === "private" ? "private" : "public";
    // ASSUMPTION: copy keeps the source content type unless x-content-type is given.
    const contentType = header(req, "x-content-type") ?? source.contentType;
    const blob = commit(toPathname, source.bytes, { contentType, access, cacheControlMaxAge: policy.cacheControlMaxAge }, policy);
    if (rename && blob.pathname !== from) blobs.delete(from);
    return putResult(blob);
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const principal = authenticate(req);
    const sub = url.pathname.slice(API_PATH.length) || "/";
    const query = url.searchParams;
    const method = req.method ?? "GET";
    const send = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };

    if (sub === "/mpu" && method === "POST") return send(await handleMpu(req, principal, query));

    if (sub === "/delete" && method === "POST") {
      requireReadWrite(principal);
      const { urls } = JSON.parse((await readBody(req)).toString()) as { urls: string[] };
      const ifMatch = header(req, "x-if-match");
      for (const target of urls) {
        const key = resolvePathname(target);
        const existing = blobs.get(key);
        if (ifMatch !== undefined && (!existing || existing.etag !== ifMatch)) {
          throw new ApiError(412, "precondition_failed", "Precondition failed");
        }
        // ASSUMPTION: deleting a missing blob succeeds silently.
        blobs.delete(key);
      }
      return send({});
    }

    if (sub === "/rename" && method === "POST") return send(copyBlob(req, principal, query, true));

    if (sub === "/" && method === "GET") {
      requireReadWrite(principal);
      if (query.has("url")) {
        const blob = blobs.get(resolvePathname(query.get("url")!));
        if (!blob) throw new ApiError(404, "not_found", "The requested blob does not exist");
        return send({
          ...putResult(blob),
          size: blob.bytes.length,
          cacheControl: blob.cacheControl,
          uploadedAt: blob.uploadedAt.toISOString(),
        });
      }
      return send(handleList(query));
    }

    if (sub === "/" && method === "PUT") {
      if (query.has("fromUrl")) return send(copyBlob(req, principal, query, false));
      const pathname = query.get("pathname") ?? "";
      assertTokenScope(principal, pathname);
      const body = await readBody(req);
      const access = header(req, "x-vercel-blob-access") === "private" ? "private" : "public";
      if (pathname.endsWith("/")) {
        // createFolder: PUT with a trailing slash and no body.
        // ASSUMPTION: creating a folder that exists is idempotent.
        requireReadWrite(principal);
        const existing = blobs.get(pathname);
        const folder =
          existing ??
          commitKey(
            pathname,
            Buffer.alloc(0),
            { contentType: "application/x-directory", access, cacheControlMaxAge: 2592000 },
            { addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 2592000 },
          );
        return send({ url: urlFor(folder.pathname), pathname: folder.pathname });
      }
      const policy = policyFromHeaders(req, principal);
      const contentType = resolveContentType(header(req, "x-content-type"), pathname);
      assertContentType(policy, contentType);
      assertSize(policy, body.length);
      const blob = commit(pathname, body, { contentType, access, cacheControlMaxAge: policy.cacheControlMaxAge }, policy);
      notifyUploadCompleted(policy, blob);
      return send(putResult(blob));
    }

    throw new ApiError(501, "bad_request", `fake does not implement ${method} ${sub}`);
  }

  async function handleMpu(req: IncomingMessage, principal: Principal, query: URLSearchParams) {
    const action = header(req, "x-mpu-action");
    const pathname = query.get("pathname") ?? "";
    assertTokenScope(principal, pathname);
    const access = header(req, "x-vercel-blob-access") === "private" ? "private" : "public";

    if (action === "create") {
      const policy = policyFromHeaders(req, principal);
      const contentType = resolveContentType(header(req, "x-content-type"), pathname);
      assertContentType(policy, contentType);
      const key = policy.addRandomSuffix ? withSuffix(pathname) : pathname;
      const uploadId = randomBytes(16).toString("hex");
      uploads.set(uploadId, { key, access, contentType, parts: new Map(), policy: { ...policy, addRandomSuffix: false } });
      return { key, uploadId };
    }

    const uploadId = header(req, "x-mpu-upload-id") ?? "";
    const session = uploads.get(uploadId);
    // ASSUMPTION: an unknown upload id is a not_found error.
    if (!session) throw new ApiError(404, "not_found", "The requested blob does not exist");
    if (decodeURIComponent(header(req, "x-mpu-key") ?? "") !== session.key) {
      throw new ApiError(400, "bad_request", "The multipart key does not match the upload id");
    }

    if (action === "upload") {
      const partNumber = Number(header(req, "x-mpu-part-number"));
      const bytes = await readBody(req);
      // ASSUMPTION: part etags are opaque; a content hash is used. S3's 5 MiB minimum part size is not enforced.
      const etag = createHash("sha256").update(bytes).digest("hex");
      session.parts.set(partNumber, { bytes, etag });
      return { etag };
    }

    if (action === "complete") {
      const parts = JSON.parse((await readBody(req)).toString()) as Array<{ partNumber: number; etag: string }>;
      // ASSUMPTION: parts are concatenated in ascending partNumber order, regardless of the order sent.
      const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const chunks: Buffer[] = [];
      for (const part of ordered) {
        const stored = session.parts.get(part.partNumber);
        if (!stored || stored.etag !== part.etag) {
          throw new ApiError(400, "bad_request", `Part ${part.partNumber} was not uploaded or its etag does not match`);
        }
        chunks.push(stored.bytes);
      }
      const bytes = Buffer.concat(chunks);
      assertSize(session.policy, bytes.length);
      const blob = commitKey(
        session.key,
        bytes,
        { contentType: session.contentType, access: session.access, cacheControlMaxAge: session.policy.cacheControlMaxAge },
        session.policy,
      );
      uploads.delete(uploadId);
      notifyUploadCompleted(session.policy, blob);
      return putResult(blob);
    }

    throw new ApiError(400, "bad_request", `Unknown mpu action ${action}`);
  }

  function serveFile(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const pathname = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const blob = blobs.get(pathname);
    if (!blob) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    if (blob.access === "private") {
      // ASSUMPTION: private blobs are readable with the read-write bearer token only.
      const authorization = header(req, "authorization");
      if (authorization !== `Bearer ${readWriteToken}`) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Forbidden");
        return;
      }
    }
    const download = url.searchParams.has("download");
    const headers: Record<string, string> = {
      etag: blob.etag,
      "cache-control": blob.cacheControl,
      "content-disposition": download ? dispositionFor(blob.pathname, true) : blob.contentDisposition,
      "last-modified": blob.uploadedAt.toUTCString(),
    };
    const ifNoneMatch = header(req, "if-none-match");
    if (ifNoneMatch && ifNoneMatch.split(",").some((v) => v.trim() === blob.etag || v.trim() === "*")) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, "content-type": blob.contentType, "content-length": String(blob.bytes.length) });
    res.end(req.method === "HEAD" ? undefined : blob.bytes);
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
    requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")])),
    });
    const run =
      url.pathname === API_PATH || url.pathname.startsWith(`${API_PATH}/`) ? handleApi(req, res, url) : Promise.resolve(serveFile(req, res, url));
    run.catch((error: unknown) => {
      if (res.headersSent) return res.destroy();
      if (error instanceof ApiError) {
        res.writeHead(error.status, { "content-type": "application/json", ...error.headers });
        res.end(JSON.stringify({ error: { code: error.code, message: error.message } }));
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "internal_server_error", message: String(error) } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    apiUrl: `${origin}${API_PATH}`,
    storeId,
    readWriteToken,
    requests,
    callbacks,
    blobCount: () => blobs.size,
    reset() {
      blobs.clear();
      uploads.clear();
      requests.length = 0;
      callbacks.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
