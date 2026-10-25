import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { cacheOptionsToEnv, type CacheOptions } from "../cache/options.js";

export interface WithNatsCacheOptions extends CacheOptions {
  useCache?: boolean;
  remote?: boolean;
  incremental?: boolean;
}

export interface WithNatsOptions {
  cache?: boolean | WithNatsCacheOptions;
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

export const USE_CACHE_HANDLER_PATH = fileURLToPath(new URL("../cache/use-cache-handler.js", import.meta.url));
export const INCREMENTAL_HANDLER_PATH = fileURLToPath(new URL("../cache/incremental-handler.js", import.meta.url));

function applyCache(config: NextConfig, cache: WithNatsOptions["cache"]): NextConfig {
  if (!cache) return config;
  const { useCache = true, remote = true, incremental = true, ...handlerOptions } = cache === true ? {} : cache;
  Object.assign(process.env, cacheOptionsToEnv(handlerOptions));
  const cacheHandlers = {
    ...config.cacheHandlers,
    ...(useCache && { default: USE_CACHE_HANDLER_PATH }),
    ...(useCache && remote && { remote: USE_CACHE_HANDLER_PATH }),
  };
  return {
    ...config,
    ...(incremental && { cacheHandler: INCREMENTAL_HANDLER_PATH }),
    ...(Object.keys(cacheHandlers).length > 0 && { cacheHandlers }),
    cacheMaxMemorySize: 0,
  };
}

export function withNats(nextConfig: NextConfig = {}, options: WithNatsOptions = {}): NextConfig {
  const external = new Set([...(nextConfig.serverExternalPackages ?? []), ...NATS_EXTERNAL_PACKAGES]);
  return applyCache({ ...nextConfig, serverExternalPackages: [...external] }, options.cache);
}
