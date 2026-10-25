import { randomBytes } from "node:crypto";

export interface BlobConfig {
  bucket: string;
  baseUrl: string;
  secret: string;
}

const KEY = Symbol.for("next-nats.blob.config");

type Holder = { [KEY]?: BlobConfig };

function fromEnv(): BlobConfig {
  return {
    bucket: process.env.NEXT_NATS_BLOB_BUCKET ?? "next_nats_blob",
    baseUrl: process.env.BLOB_BASE_URL ?? "/blob",
    secret: process.env.BLOB_SECRET ?? randomBytes(32).toString("hex"),
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
