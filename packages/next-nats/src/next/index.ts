import type { NextConfig } from "next";

export interface WithNatsOptions {
  cache?: {
    cacheHandler?: string;
    cacheHandlers?: NonNullable<NextConfig["cacheHandlers"]>;
    disableDefaultInMemory?: boolean;
  };
}

export const NATS_EXTERNAL_PACKAGES = [
  "@nats-io/nats-core",
  "@nats-io/transport-node",
  "@nats-io/jetstream",
  "@nats-io/kv",
  "@nats-io/obj",
  "@nats-io/services",
  "nkeys.js",
];

function applyCache(config: NextConfig, cache: WithNatsOptions["cache"]): NextConfig {
  if (!cache) return config;
  return {
    ...config,
    ...(cache.cacheHandler && { cacheHandler: cache.cacheHandler }),
    ...(cache.cacheHandlers && { cacheHandlers: { ...config.cacheHandlers, ...cache.cacheHandlers } }),
    ...(cache.disableDefaultInMemory && { cacheMaxMemorySize: 0 }),
  };
}

export function withNats(nextConfig: NextConfig = {}, options: WithNatsOptions = {}): NextConfig {
  const external = new Set([...(nextConfig.serverExternalPackages ?? []), ...NATS_EXTERNAL_PACKAGES]);
  return applyCache({ ...nextConfig, serverExternalPackages: [...external] }, options.cache);
}
