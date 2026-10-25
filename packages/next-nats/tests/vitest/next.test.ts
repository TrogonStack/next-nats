import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERCEL_IMPORT_ALIASES, resolvePlatform, withNats } from "../../src/next/index.js";
import { readVercelCrons } from "../../src/cron/index.js";
import { readVercelJson } from "../../src/queue/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("withNats platform", () => {
  it("is self-hosted unless VERCEL is set", () => {
    expect(resolvePlatform(undefined, {})).toBe("self-hosted");
    expect(resolvePlatform(undefined, { VERCEL: "1" })).toBe("vercel");
    expect(resolvePlatform("self-hosted", { VERCEL: "1" })).toBe("self-hosted");
    expect(resolvePlatform("vercel", {})).toBe("vercel");
  });

  it("aliases the real specifiers for turbopack and webpack when self-hosted", () => {
    const config = withNats({}, { platform: "self-hosted", vercelJson: false });
    expect(config.turbopack?.resolveAlias).toEqual(VERCEL_IMPORT_ALIASES);
    const result = config.webpack?.({ resolve: { alias: { keep: "me" } } } as never, {} as never) as { resolve: { alias: Record<string, string> } };
    expect(result.resolve.alias).toMatchObject({ keep: "me", "@vercel/blob$": "@trogonstack/next-nats/blob", "@vercel/blob/client$": "@trogonstack/next-nats/blob/client" });
  });

  it("adds no aliases and no cache handlers on vercel", () => {
    const config = withNats({}, { platform: "vercel", cache: true });
    expect(config.turbopack).toBeUndefined();
    expect(config.webpack).toBeUndefined();
    expect(config.cacheHandlers).toBeUndefined();
    expect(config.cacheHandler).toBeUndefined();
    expect(config.env).toBeUndefined();
  });

  it("keeps user aliases and chains the user webpack hook", () => {
    const user = vi.fn((c) => c);
    const config = withNats({ turbopack: { resolveAlias: { "@vercel/kv": "./mine.ts" } }, webpack: user }, { platform: "self-hosted", vercelJson: false });
    expect(config.turbopack?.resolveAlias?.["@vercel/kv"]).toBe("./mine.ts");
    config.webpack?.({} as never, {} as never);
    expect(user).toHaveBeenCalled();
  });
});

describe("embedded vercel.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "vj-"));
  const file = join(dir, "vercel.json");
  const body = { crons: [{ path: "/api/x", schedule: "* * * * *" }], functions: { "src/app/api/q/route.ts": { experimentalTriggers: [{ type: "queue/v2beta", topic: "t" }] } } };
  writeFileSync(file, JSON.stringify(body));

  it("is captured into env by withNats", () => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const config = withNats({}, { platform: "self-hosted" });
    expect(JSON.parse(config.env!.NEXT_NATS_VERCEL_JSON!)).toEqual(body);
  });

  it("is preferred by cron and queue loaders over the filesystem", () => {
    vi.stubEnv("NEXT_NATS_VERCEL_JSON", JSON.stringify(body));
    vi.spyOn(process, "cwd").mockReturnValue(join(dir, "nowhere"));
    expect(readVercelCrons()).toEqual(body.crons);
    expect(Object.keys(readVercelJson().functions ?? {})).toEqual(["src/app/api/q/route.ts"]);
  });

  it("falls back to the file when nothing is embedded", () => {
    vi.stubEnv("NEXT_NATS_VERCEL_JSON", "");
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    expect(readVercelCrons()).toEqual(body.crons);
    rmSync(dir, { recursive: true });
    expect(readVercelCrons()).toEqual([]);
  });
});
