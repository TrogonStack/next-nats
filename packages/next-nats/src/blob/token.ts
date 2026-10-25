import { createHmac, timingSafeEqual } from "node:crypto";
import { getBlobConfig } from "./config.js";
import { blobUrl } from "./store.js";
import { BlobAccessError, BlobClientTokenExpiredError } from "./errors.js";

export type BlobOperation = "get" | "put";

export interface BlobTokenPayload {
  pathname: string;
  operation: BlobOperation;
  validUntil: number;
  maximumSizeInBytes?: number;
  allowedContentTypes?: string[];
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
}

function mac(body: string): string {
  return createHmac("sha256", getBlobConfig().secret).update(body).digest("base64url");
}

export function signBlobToken(payload: BlobTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body)}`;
}

export function verifyBlobToken(token: string, now = Date.now()): BlobTokenPayload {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new BlobAccessError();
  const expected = Buffer.from(mac(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new BlobAccessError();
  const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as BlobTokenPayload;
  if (payload.validUntil < now) throw new BlobClientTokenExpiredError();
  return payload;
}

export interface SignedUrlOptions {
  expiresIn?: number;
}

export function signedBlobToken(pathname: string, operation: BlobOperation, opts: SignedUrlOptions & Partial<BlobTokenPayload> = {}): string {
  const { expiresIn = 3_600_000, ...rest } = opts;
  return signBlobToken({ ...rest, pathname, operation, validUntil: Date.now() + expiresIn });
}

export interface UploadUrlOptions extends SignedUrlOptions {
  maximumSizeInBytes?: number;
  allowedContentTypes?: string[];
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
}

export function createUploadUrl(pathname: string, opts: UploadUrlOptions = {}): { url: string; token: string; expiresAt: number } {
  const token = signedBlobToken(pathname, "put", opts);
  const { validUntil } = verifyBlobToken(token);
  return { url: `${blobUrl(pathname)}?token=${encodeURIComponent(token)}`, token, expiresAt: validUntil };
}

export function createSignedUrl(pathname: string, opts: SignedUrlOptions = {}): string {
  return `${blobUrl(pathname)}?token=${encodeURIComponent(signedBlobToken(pathname, "get", opts))}`;
}
