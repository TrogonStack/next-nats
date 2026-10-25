import "server-only";
import { sliceStream } from "./body.js";
import { getBlobStore, describe, etagOf, matchesEtag, put, statBlob, del } from "./store.js";
import { publicErrorResponse } from "../errors.js";
import { BlobError, BlobFileTooLargeError } from "./errors.js";
import { verifyBlobToken, type BlobTokenPayload } from "./token.js";

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

function tokenFor(request: Request): BlobTokenPayload | null {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return null;
  try {
    return verifyBlobToken(token);
  } catch {
    return null;
  }
}

export function createBlobRoute(options: BlobRouteOptions = {}) {
  const permitted = async (request: Request, pathname: string, access: string, operation: "get" | "put") => {
    const token = tokenFor(request);
    if (token && token.operation === operation && token.pathname === pathname) return true;
    if (options.authorize && (await options.authorize(request, pathname))) return true;
    return operation === "get" && access === "public";
  };

  const serve = async (request: Request, ctx: RouteContext, method: "GET" | "HEAD"): Promise<Response> => {
    const pathname = await pathnameOf(ctx);
    const store = await getBlobStore(options.bucket);
    const info = pathname ? await statBlob(pathname, store) : null;
    if (!info) return new Response("Not found", { status: 404 });
    const d = describe(info);
    if (!(await permitted(request, pathname, d.access, "get"))) return new Response("Forbidden", { status: 403 });

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

  return {
    GET: (request: Request, ctx: RouteContext) => serve(request, ctx, "GET"),
    HEAD: (request: Request, ctx: RouteContext) => serve(request, ctx, "HEAD"),
    async PUT(request: Request, ctx: RouteContext): Promise<Response> {
      const pathname = await pathnameOf(ctx);
      const token = tokenFor(request);
      if (!token || token.operation !== "put" || token.pathname !== pathname) {
        return new Response("Forbidden", { status: 403 });
      }
      const contentType = request.headers.get("content-type") ?? undefined;
      if (token.allowedContentTypes?.length && !matches(contentType, token.allowedContentTypes)) {
        return new Response("Content type not allowed", { status: 415 });
      }
      if (!request.body) return new Response("Body required", { status: 400 });
      try {
        const result = await put(pathname, request.body, {
          access: "public",
          contentType,
          addRandomSuffix: token.addRandomSuffix,
          allowOverwrite: token.allowOverwrite,
          maximumSizeInBytes: token.maximumSizeInBytes,
        });
        return Response.json(result, { status: 200 });
      } catch (error) {
        if (error instanceof BlobError) {
          return publicErrorResponse(error, { status: error instanceof BlobFileTooLargeError ? 413 : undefined });
        }
        throw error;
      }
    },
    async DELETE(request: Request, ctx: RouteContext): Promise<Response> {
      const pathname = await pathnameOf(ctx);
      const allowed = options.authorize ? await options.authorize(request, pathname) : false;
      if (!allowed) return new Response("Forbidden", { status: 403 });
      await del(pathname);
      return new Response(null, { status: 204 });
    },
  };
}

function matches(contentType: string | undefined, allowed: string[]): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return allowed.some((rule) => (rule.endsWith("/*") ? type.startsWith(rule.slice(0, -1)) : type === rule.toLowerCase()));
}
