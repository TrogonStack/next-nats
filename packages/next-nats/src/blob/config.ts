import { failedPrecondition } from "../errors.js";
import { warnThrottled } from "../logger.js";
import { secretFromEnv } from "../secret.js";

export interface BlobConfig {
  bucket: string;
  baseUrl: string;
  secret?: string;
}

const KEY = Symbol.for("next-nats.blob.config");

type Holder = { [KEY]?: BlobConfig };

function fallbackSecret(): string {
  if (process.env.NODE_ENV === "production") {
    throw failedPrecondition("next-nats.blob", "MISSING_SECRET", "Set BLOB_SECRET or BLOB_READ_WRITE_TOKEN so every replica signs and verifies blob tokens with the same key");
  }
  warnThrottled("blob.secret", "BLOB_SECRET is unset, using a random per-process secret; signed blob URLs only work on this process");
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromEnv(): BlobConfig {
  return {
    bucket: process.env.NEXT_NATS_BLOB_BUCKET ?? "next_nats_blob",
    baseUrl: process.env.BLOB_BASE_URL ?? process.env.NEXT_PUBLIC_BLOB_BASE_URL ?? "/blob",
    secret: secretFromEnv(process.env.BLOB_SECRET)?.reveal() ?? secretFromEnv(process.env.BLOB_READ_WRITE_TOKEN)?.reveal(),
  };
}

export function configureBlob(input: Partial<BlobConfig>): BlobConfig {
  const g = globalThis as Holder;
  g[KEY] = { ...(g[KEY] ?? fromEnv()), ...input };
  return g[KEY];
}

export function getBlobConfig(): BlobConfig {
  const g = globalThis as Holder;
  return (g[KEY] ??= fromEnv());
}

export function getBlobSecret(): string {
  const config = getBlobConfig();
  return (config.secret ??= fallbackSecret());
}
