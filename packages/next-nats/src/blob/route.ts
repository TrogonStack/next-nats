import "server-only";
import { inferContentType, sliceStream } from "./body.js";
import {
  completeMultipartUpload,
  createFolder,
  createMultipartUpload,
  del,
  describe,
  etagOf,
  getBlobStore,
  matchesEtag,
  put,
  statBlob,
  uploadPart,
} from "./store.js";
import { publicErrorResponse } from "../errors.js";
import {
  BlobAccessError,
  BlobContentTypeNotAllowedError,
  BlobError,
  BlobFileTooLargeError,
  BlobPathnameMismatchError,
} from "./errors.js";
import {
  CLIENT_TOKEN_PREFIX,
  SIGNATURE_HEADER,
  grantFromClientToken,
  signCallbackBody,
  verifyPresignedParams,
  type Grant,
} from "./token.js";
import type { BlobAccessType, Part, PutBlobResult } from "./types.js";

type RouteContext = { params: Promise<{ path?: string[] | string }> };

export interface BlobRouteOptions {
  bucket?: string;
  authorize?: (request: Request, pathname: string) => boolean | Promise<boolean>;
  maxAge?: number;
}

export interface ByteRange {
  start: number;
  end: number;
}

export function parseRange(header: string, size: number): ByteRange | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

async function pathnameOf(ctx: RouteContext): Promise<string> {
  const { path } = await ctx.params;
  const segments = Array.isArray(path) ? path : path ? [path] : [];
  return segments.join("/");
}

function bearerOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return new URL(request.url).searchParams.get("token");
}

async function grantOf(request: Request): Promise<Grant | null> {
  const bearer = bearerOf(request);
  if (bearer?.startsWith(CLIENT_TOKEN_PREFIX)) return grantFromClientToken(bearer);
  if (new URL(request.url).searchParams.has("delegationToken")) return verifyPresignedParams(new URL(request.url).searchParams);
  return null;
}

function matchesContentType(contentType: string, allowed: string[]): boolean {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return allowed.some((rule) => (rule.endsWith("/*") ? type.startsWith(rule.slice(0, -1).toLowerCase()) : type === rule.toLowerCase()));
}

function assertContentType(grant: Grant, contentType: string): void {
  if (grant.allowedContentTypes?.length && !matchesContentType(contentType, grant.allowedContentTypes)) {
    throw new BlobContentTypeNotAllowedError(`${contentType} is not allowed`);
  }
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof BlobFileTooLargeError) return 413;
  if (error instanceof BlobContentTypeNotAllowedError) return 415;
  return undefined;
}

function notifyUploadCompleted(grant: Grant, blob: PutBlobResult): void {
  const target = grant.onUploadCompleted;
  if (!target) return;
  const body = JSON.stringify({
    type: "blob.upload-completed",
    payload: { blob, tokenPayload: target.tokenPayload ?? null },
  });
  void signCallbackBody(body)
    .then((signature) =>
      fetch(target.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature },
        body,
      }),
    )
    .catch(() => undefined);
}

export function createBlobRoute(options: BlobRouteOptions = {}) {
  const guard = (handler: (request: Request, ctx: RouteContext) => Promise<Response>) => async (request: Request, ctx: RouteContext) => {
    try {
      return await handler(request, ctx);
    } catch (error) {
      if (error instanceof BlobError) return publicErrorResponse(error, { status: statusOf(error) });
      throw error;
    }
  };

  const authorizedByHook = async (request: Request, pathname: string) =>
    options.authorize ? await options.authorize(request, pathname) : false;

  const requireGrant = async (request: Request, pathname: string, operation: "put" | "delete"): Promise<Grant | null> => {
    const grant = await grantOf(request);
    if (grant) {
      if (grant.operation !== operation) throw new BlobAccessError();
      if (grant.pathname !== pathname) {
        throw new BlobPathnameMismatchError(`tried to ${operation} "${pathname}", but the token was issued for "${grant.pathname}"`);
      }
      return grant;
    }
    if (await authorizedByHook(request, pathname)) return null;
    throw new BlobAccessError();
  };

  const permitted = async (request: Request, pathname: string, access: BlobAccessType, method: "GET" | "HEAD") => {
    if (access === "public") return true;
    const grant = await grantOf(request).catch(() => null);
    if (grant && grant.pathname === pathname && (grant.operation === "get" || (method === "HEAD" && grant.operation === "head"))) {
      return true;
    }
    return authorizedByHook(request, pathname);
  };

  const serve = async (request: Request, ctx: RouteContext, method: "GET" | "HEAD"): Promise<Response> => {
    const pathname = await pathnameOf(ctx);
    const store = await getBlobStore(options.bucket);
    const info = pathname ? await statBlob(pathname, store) : null;
    if (!info) return new Response("Not found", { status: 404 });
    const d = describe(info);
    if (!(await permitted(request, pathname, d.access, method))) return new Response("Forbidden", { status: 403 });

    const download = new URL(request.url).searchParams.has("download");
    const etag = etagOf(info);
    const cacheControl =
      d.access === "private" ? "private, no-store" : options.maxAge !== undefined ? `public, max-age=${options.maxAge}` : d.cacheControl;
    const headers = new Headers({
      ETag: etag,
      "Cache-Control": cacheControl,
      "Content-Type": d.contentType,
      "Content-Disposition": download ? d.contentDisposition.replace(/^inline/, "attachment") : d.contentDisposition,
      "Accept-Ranges": "bytes",
      "Last-Modified": d.uploadedAt.toUTCString(),
      "X-Content-Type-Options": "nosniff",
    });

    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch && matchesEtag(ifNoneMatch, etag)) return new Response(null, { status: 304, headers });

    let range: ByteRange | null = null;
    const rangeHeader = request.headers.get("range");
    const ifRange = request.headers.get("if-range");
    if (rangeHeader && (!ifRange || ifRange === etag)) {
      const parsed = parseRange(rangeHeader, info.size);
      if (parsed === "unsatisfiable") {
        headers.set("Content-Range", `bytes */${info.size}`);
        return new Response(null, { status: 416, headers });
      }
      range = parsed;
    }

    const status = range ? 206 : 200;
    const length = range ? range.end - range.start + 1 : info.size;
    headers.set("Content-Length", String(length));
    if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${info.size}`);
    if (method === "HEAD" || length === 0) return new Response(null, { status, headers });

    const result = await store.get(pathname);
    if (!result) return new Response("Not found", { status: 404 });
    let body = result.data;
    if (range) body = sliceStream(body, range.start, range.end);
    request.signal.addEventListener("abort", () => void body.cancel().catch(() => undefined), { once: true });
    return new Response(body, { status, headers });
  };

  const accessOf = (request: Request, grant: Grant | null): BlobAccessType => {
    const declared = request.headers.get("x-blob-access") ?? grant?.access;
    return declared === "private" ? "private" : "public";
  };

  const contentTypeOf = (request: Request, pathname: string): string =>
    request.headers.get("x-content-type") ?? request.headers.get("content-type") ?? inferContentType(pathname);

  return {
    GET: guard((request, ctx) => serve(request, ctx, "GET")),
    HEAD: guard((request, ctx) => serve(request, ctx, "HEAD")),

    PUT: guard(async (request, ctx) => {
      const pathname = await pathnameOf(ctx);
      const grant = await requireGrant(request, pathname, "put");
      if (!grant) throw new BlobAccessError();
      const search = new URL(request.url).searchParams;
      if (!request.body) return new Response("Body required", { status: 400 });

      if (search.get("mpu") === "part") {
        const part = await uploadPart(pathname, request.body, {
          access: accessOf(request, grant),
          key: search.get("key") ?? "",
          uploadId: search.get("uploadId") ?? "",
          partNumber: Number(search.get("partNumber")),
        });
        return Response.json(part);
      }

      const contentType = contentTypeOf(request, pathname);
      assertContentType(grant, contentType);
      const result = await put(pathname, request.body, {
        access: accessOf(request, grant),
        contentType,
        addRandomSuffix: grant.addRandomSuffix,
        allowOverwrite: grant.allowOverwrite,
        cacheControlMaxAge: grant.cacheControlMaxAge,
        ifMatch: grant.ifMatch,
        maximumSizeInBytes: grant.maximumSizeInBytes,
      });
      notifyUploadCompleted(grant, result);
      return Response.json(result);
    }),

    POST: guard(async (request, ctx) => {
      const pathname = await pathnameOf(ctx);
      if (new URL(request.url).searchParams.get("action") === "create-folder") {
        if (!(await authorizedByHook(request, pathname))) throw new BlobAccessError();
        return Response.json(await createFolder(pathname, { access: accessOf(request, null) }));
      }
      const grant = await requireGrant(request, pathname, "put");
      if (!grant) throw new BlobAccessError();
      const search = new URL(request.url).searchParams;
      const access = accessOf(request, grant);

      if (search.get("mpu") === "create") {
        const contentType = contentTypeOf(request, pathname);
        assertContentType(grant, contentType);
        return Response.json(
          await createMultipartUpload(pathname, {
            access,
            contentType,
            addRandomSuffix: grant.addRandomSuffix,
            allowOverwrite: grant.allowOverwrite,
            cacheControlMaxAge: grant.cacheControlMaxAge,
            ifMatch: grant.ifMatch,
            maximumSizeInBytes: grant.maximumSizeInBytes,
          }),
        );
      }

      if (search.get("mpu") === "complete") {
        const parts = (await request.json()) as Part[];
        const result = await completeMultipartUpload(pathname, parts, {
          access,
          key: search.get("key") ?? "",
          uploadId: search.get("uploadId") ?? "",
        });
        notifyUploadCompleted(grant, result);
        return Response.json(result);
      }

      return new Response("Unknown multipart action", { status: 400 });
    }),

    DELETE: guard(async (request, ctx) => {
      const pathname = await pathnameOf(ctx);
      const grant = await requireGrant(request, pathname, "delete");
      await del(pathname, { ifMatch: grant?.ifMatch });
      return new Response(null, { status: 204 });
    }),
  };
}
