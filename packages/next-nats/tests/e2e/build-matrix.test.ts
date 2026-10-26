import { beforeAll, describe, expect, it } from "vitest";
import { bundleText, requiredServerConfig, type ServerFilesConfig } from "./support/bundle.js";
import { SELF_HOSTED_VARIANTS } from "./support/env.js";

interface Mirror {
  specifier: string;
  ours: string;
  real: string;
  // the demo also imports the NATS subpath itself, so its marker is present in every build
  importedDirectlyByDemo: boolean;
}

const MIRRORS: Mirror[] = [
  { specifier: "@vercel/kv", ours: "next-nats.kv", real: "KV_REST_API_URL", importedDirectlyByDemo: true },
  { specifier: "@upstash/redis", ours: "next-nats.kv", real: "UPSTASH_REDIS_REST_URL", importedDirectlyByDemo: true },
  { specifier: "@upstash/ratelimit", ours: "Ratelimit enableProtection", real: "denyList", importedDirectlyByDemo: false },
  { specifier: "@vercel/blob", ours: "next-nats.blob", real: "vercel.com/api/blob", importedDirectlyByDemo: true },
  { specifier: "@vercel/edge-config", ours: "next-nats.edge-config", real: "x-edge-config-digest", importedDirectlyByDemo: true },
  { specifier: "@vercel/queue", ours: "next-nats.queue", real: "x-vercel-queue", importedDirectlyByDemo: true },
];

const mentions = (bundles: string, marker: string) => bundles.includes(marker);

describe.each(SELF_HOSTED_VARIANTS)("self-hosted %s build", (variant) => {
  let bundles: string;
  let config: ServerFilesConfig;

  beforeAll(async () => {
    bundles = `${await bundleText(variant, "server")}\n${await bundleText(variant, "static")}`;
    config = await requiredServerConfig(variant);
  });

  it.each(MIRRORS)("routes $specifier to the NATS implementation", ({ ours, real }) => {
    expect(mentions(bundles, ours), `bundle mentions ${ours}`).toBe(true);
    expect(mentions(bundles, real), `bundle mentions ${real}`).toBe(false);
  });

  it("registers the NATS cache handlers", () => {
    expect(config.cacheHandler).toMatch(/cache\/incremental-handler\.js$/);
    expect(config.cacheHandlers?.default).toMatch(/cache\/use-cache-handler\.js$/);
    expect(config.cacheHandlers?.remote).toMatch(/cache\/use-cache-handler\.js$/);
  });

  it("embeds vercel.json so the crons and queue triggers need no file at runtime", () => {
    const embedded = JSON.parse(config.env?.NEXT_NATS_VERCEL_JSON ?? "null") as { crons?: unknown[] } | null;
    expect(embedded?.crons).toEqual([{ path: "/api/cron/heartbeat", schedule: "* * * * *" }]);
  });
});

describe("VERCEL=1 build", () => {
  let bundles: string;
  let config: ServerFilesConfig;

  beforeAll(async () => {
    bundles = `${await bundleText("vercel", "server")}\n${await bundleText("vercel", "static")}`;
    config = await requiredServerConfig("vercel");
  });

  it.each(MIRRORS)("keeps the real $specifier", ({ real }) => {
    expect(mentions(bundles, real), `bundle mentions ${real}`).toBe(true);
  });

  it.each(MIRRORS.filter((mirror) => !mirror.importedDirectlyByDemo))("leaves no trace of the NATS $specifier", ({ ours }) => {
    expect(mentions(bundles, ours), `bundle mentions ${ours}`).toBe(false);
  });

  it("does not configure the NATS cache handlers", () => {
    expect(config.cacheHandler).toBeUndefined();
    expect(Object.keys(config.cacheHandlers ?? {})).toEqual([]);
  });

  it("does not embed vercel.json, because Vercel reads it itself", () => {
    expect(config.env?.NEXT_NATS_VERCEL_JSON).toBeUndefined();
  });
});
