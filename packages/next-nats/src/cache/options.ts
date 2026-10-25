export interface CacheOptions {
  namespace?: string;
  ttl?: number;
  lruBytes?: number;
  inlineLimit?: number;
  replicas?: number;
}

export interface ResolvedCacheOptions {
  namespace: string;
  ttl: number;
  lruBytes: number;
  inlineLimit?: number;
  replicas: number;
}

export const CACHE_ENV = {
  namespace: "NEXT_NATS_CACHE_NAMESPACE",
  ttl: "NEXT_NATS_CACHE_TTL_MS",
  lruBytes: "NEXT_NATS_CACHE_LRU_BYTES",
  inlineLimit: "NEXT_NATS_CACHE_INLINE_LIMIT",
  replicas: "NEXT_NATS_CACHE_REPLICAS",
} as const;

const DEFAULT_TTL = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LRU_BYTES = 64 * 1024 * 1024;

type Env = Record<string, string | undefined>;

function num(env: Env, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${key} must be a non-negative number, got "${raw}"`);
  return value;
}

export function resolveCacheOptions(input: CacheOptions = {}, env: Env = process.env): ResolvedCacheOptions {
  return {
    namespace: input.namespace ?? (env[CACHE_ENV.namespace] || "next_cache"),
    ttl: input.ttl ?? num(env, CACHE_ENV.ttl) ?? DEFAULT_TTL,
    lruBytes: input.lruBytes ?? num(env, CACHE_ENV.lruBytes) ?? DEFAULT_LRU_BYTES,
    inlineLimit: input.inlineLimit ?? num(env, CACHE_ENV.inlineLimit),
    replicas: input.replicas ?? num(env, CACHE_ENV.replicas) ?? 1,
  };
}

export function cacheOptionsToEnv(options: CacheOptions): Record<string, string> {
  const out: Record<string, string> = {};
  if (options.namespace !== undefined) out[CACHE_ENV.namespace] = options.namespace;
  if (options.ttl !== undefined) out[CACHE_ENV.ttl] = String(options.ttl);
  if (options.lruBytes !== undefined) out[CACHE_ENV.lruBytes] = String(options.lruBytes);
  if (options.inlineLimit !== undefined) out[CACHE_ENV.inlineLimit] = String(options.inlineLimit);
  if (options.replicas !== undefined) out[CACHE_ENV.replicas] = String(options.replicas);
  return out;
}
