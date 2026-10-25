import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { cacheOptionsToEnv, type CacheOptions } from "../cache/options.js";
import { VERCEL_JSON_ENV } from "../vercel-json.js";

export interface WithNatsCacheOptions extends CacheOptions {
  useCache?: boolean;
  remote?: boolean;
  incremental?: boolean;
}

export type WithNatsPlatform = "vercel" | "self-hosted";

export interface WithNatsOptions {
  cache?: boolean | WithNatsCacheOptions;
  platform?: WithNatsPlatform;
  vercelJson?: string | false;
}

export const VERCEL_IMPORT_ALIASES: Readonly<Record<string, string>> = {
  "@upstash/redis": "@trogonstack/next-nats/redis",
  "@vercel/kv": "@trogonstack/next-nats/kv",
  "@upstash/ratelimit": "@trogonstack/next-nats/ratelimit",
  "@vercel/blob": "@trogonstack/next-nats/blob",
  "@vercel/blob/client": "@trogonstack/next-nats/blob/client",
  "@vercel/edge-config": "@trogonstack/next-nats/edge-config",
  "@vercel/queue": "@trogonstack/next-nats/queue",
};

export function resolvePlatform(platform?: WithNatsPlatform, env: Record<string, string | undefined> = process.env): WithNatsPlatform {
  if (platform) return platform;
  return env.VERCEL ? "vercel" : "self-hosted";
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

function applyAliases(config: NextConfig): NextConfig {
  const webpack: NextConfig["webpack"] = (webpackConfig, context) => {
    const aliases = Object.fromEntries(Object.entries(VERCEL_IMPORT_ALIASES).map(([from, to]) => [`${from}$`, to]));
    webpackConfig.resolve = {
      ...webpackConfig.resolve,
      alias: { ...webpackConfig.resolve?.alias, ...aliases },
    };
    return config.webpack ? config.webpack(webpackConfig, context) : webpackConfig;
  };
  return {
    ...config,
    turbopack: {
      ...config.turbopack,
      resolveAlias: { ...VERCEL_IMPORT_ALIASES, ...config.turbopack?.resolveAlias },
    },
    webpack,
  };
}

function applyVercelJson(config: NextConfig, vercelJson: WithNatsOptions["vercelJson"]): NextConfig {
  if (vercelJson === false) return config;
  const file = resolve(/* turbopackIgnore: true */ process.cwd(), vercelJson ?? "vercel.json");
  if (!existsSync(file)) return config;
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  return { ...config, env: { ...config.env, [VERCEL_JSON_ENV]: JSON.stringify(raw) } };
}

export function withNats(nextConfig: NextConfig = {}, options: WithNatsOptions = {}): NextConfig {
  const external = new Set([...(nextConfig.serverExternalPackages ?? []), ...NATS_EXTERNAL_PACKAGES]);
  const base = { ...nextConfig, serverExternalPackages: [...external] };
  if (resolvePlatform(options.platform) === "vercel") return base;
  return applyCache(applyVercelJson(applyAliases(base), options.vercelJson), options.cache);
}
