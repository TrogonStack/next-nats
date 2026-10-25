import { BlobError } from "./errors.js";

const MAXIMUM_PATHNAME_LENGTH = 950;

function invalidPathname(message: string): BlobError {
  return new BlobError(message, { reason: "INVALID_PATHNAME", subject: "/pathname" });
}

export function assertPathname(pathname: string, allowFolder = false): void {
  if (!pathname) throw invalidPathname("pathname is required");
  if (pathname.length > MAXIMUM_PATHNAME_LENGTH) {
    throw invalidPathname(`pathname is too long, maximum length is ${MAXIMUM_PATHNAME_LENGTH}`);
  }
  if (pathname.includes("//")) throw invalidPathname('pathname cannot contain "//", please encode it if needed');
  if (!allowFolder && pathname.endsWith("/")) throw invalidPathname("pathname cannot end with a slash");
}

export function assertAccess(options: { access?: unknown } | undefined): void {
  if (!options) throw new BlobError("missing options, see usage", { reason: "MISSING_OPTIONS", subject: "/options" });
  if (options.access !== "public" && options.access !== "private") {
    throw new BlobError('access must be "private" or "public", see https://vercel.com/docs/vercel-blob', {
      reason: "INVALID_ACCESS",
      subject: "/access",
    });
  }
}

function isPlainObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === null || prototype === Object.prototype || Object.getPrototypeOf(prototype) === null) &&
    !(Symbol.toStringTag in value) &&
    !(Symbol.iterator in value)
  );
}

export function assertBody(body: unknown): void {
  if (!body) throw new BlobError("body is required", { reason: "BODY_REQUIRED", subject: "/body" });
  assertBodyShape(body);
}

export function assertBodyShape(body: unknown): void {
  if (isPlainObject(body)) {
    throw new BlobError(
      "Body must be a string, buffer or stream. You sent a plain JavaScript object, double check what you're trying to upload.",
      { reason: "UNSUPPORTED_BODY", subject: "/body" },
    );
  }
}

export function assertConsistentIfMatch(options: { ifMatch?: string; allowOverwrite?: boolean }): void {
  if (options.ifMatch && options.allowOverwrite === false) {
    throw new BlobError(
      "ifMatch and allowOverwrite: false are contradictory. ifMatch is used for conditional overwrites, which requires allowOverwrite to be true.",
      { reason: "CONTRADICTORY_OPTIONS", subject: "/ifMatch" },
    );
  }
}
