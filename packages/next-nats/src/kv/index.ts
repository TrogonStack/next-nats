import "server-only";
import { createKv, NatsKv } from "./client.js";

export { createKv, NatsKv } from "./client.js";
export type { ExpireOption, KvValue, ScanOptions, SetOptions } from "./client.js";
export { KvError, KvStore } from "./store.js";
export type { KvRecord, KvStoreOptions } from "./store.js";
export { decodeKey, encodeKey, globToRegExp } from "./key.js";
export type { KvKey } from "./key.js";

export const kv: NatsKv = createKv({ bucket: process.env.NEXT_NATS_KV_BUCKET ?? "kv" });
