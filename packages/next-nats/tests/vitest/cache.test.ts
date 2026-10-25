import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CacheEntry } from "next/cache.js";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import { createIncrementalCacheHandler, createUseCacheHandler, bucketNames } from "../../src/cache/index.js";
import { pack, unpack } from "../../src/cache/pack.js";

const run = Math.random().toString(36).slice(2, 8);
const namespace = `t_cache_${run}`;
const options = { namespace, shared: false, lruBytes: 8 * 1024 * 1024 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn: () => Promise<boolean> | boolean, ms = 5_000) {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await sleep(10);
  }
  return Date.now() - start;
}

function entry(text: string, overrides: Partial<Omit<CacheEntry, "value">> = {}): Promise<CacheEntry> {
  return Promise.resolve({
    value: new Response(text).body as ReadableStream<Uint8Array>,
    tags: [],
    stale: 30,
    timestamp: Date.now(),
    expire: 3600,
    revalidate: 60,
    ...overrides,
  });
}

async function read(found: CacheEntry | undefined): Promise<string | undefined> {
  return found ? new Response(found.value).text() : undefined;
}

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_SERVERS, name: "next-nats-cache-test" });
});

afterAll(async () => {
  const { jsm } = await getNats();
  const names = bucketNames(namespace);
  for (const stream of [`KV_${names.data}`, `KV_${names.isr}`, `KV_${names.tags}`, `OBJ_${names.objects}`]) {
    await jsm.streams.delete(stream).catch(() => undefined);
  }
  await closeNats();
});

describe("pack", () => {
  it("round trips buffers and maps", () => {
    const value = {
      kind: "APP_PAGE",
      html: "<p>é</p>",
      rscData: Buffer.from([1, 2, 3, 0, 255]),
      segmentData: new Map([["/a", Buffer.from("seg")]]),
      status: undefined,
    };
    const out = unpack<typeof value>(pack(value));
    expect(out.html).toBe(value.html);
    expect(Buffer.isBuffer(out.rscData)).toBe(true);
    expect([...out.rscData]).toEqual([1, 2, 3, 0, 255]);
    expect(out.segmentData.get("/a")?.toString()).toBe("seg");
  });
});

describe("use cache handler", () => {
  it("stores and serves entries with a fresh stream per get", async () => {
    const a = createUseCacheHandler(options);
    await a.set("k1", entry("hello", { tags: ["x"] }));
    const first = await a.get("k1", []);
    expect(first?.tags).toEqual(["x"]);
    expect(first?.revalidate).toBe(60);
    expect(await read(first)).toBe("hello");
    expect(await read(await a.get("k1", []))).toBe("hello");
    expect(await a.get("missing", [])).toBeUndefined();
    await a.close();
  });

  it("waits for a pending set before answering a get", async () => {
    const a = createUseCacheHandler(options);
    const pending = a.set("k2", new Promise((resolve) => setTimeout(() => resolve(entry("late")), 100)).then((e) => e as CacheEntry));
    await sleep(10);
    expect(await read(await a.get("k2", []))).toBe("late");
    await pending;
    await a.close();
  });

  it("skips dynamic entries with expire 0", async () => {
    const a = createUseCacheHandler(options);
    await a.set("k3", entry("dyn", { expire: 0 }));
    expect(await a.get("k3", [])).toBeUndefined();
    await a.close();
  });

  it("propagates updateTags across handlers with separate front caches", async () => {
    const a = createUseCacheHandler(options);
    const b = createUseCacheHandler(options);
    await a.set("k4", entry("v1", { tags: ["t4"] }));
    expect(await read(await b.get("k4", []))).toBe("v1");
    await sleep(5);
    await a.updateTags(["t4"]);
    const elapsed = await waitFor(async () => (await b.get("k4", [])) === undefined);
    console.log(`tag invalidation observed on peer after ${elapsed}ms`);
    expect(elapsed).toBeLessThan(1_000);
    await a.set("k4", entry("v2", { tags: ["t4"] }));
    await waitFor(async () => (await read(await b.get("k4", []))) === "v2");
    await a.close();
    await b.close();
  });

  it("marks entries stale for profile based revalidation", async () => {
    const a = createUseCacheHandler(options);
    const b = createUseCacheHandler(options);
    await a.set("k5", entry("v1", { tags: ["t5"] }));
    await b.get("k5", []);
    await sleep(5);
    await a.updateTags(["t5"], { expire: 3600 });
    await waitFor(async () => (await b.get("k5", []))?.revalidate === -1);
    expect(await read(await b.get("k5", []))).toBe("v1");
    await a.close();
    await b.close();
  });

  it("honors soft tags in get and getExpiration", async () => {
    const a = createUseCacheHandler(options);
    const b = createUseCacheHandler(options);
    await a.set("k6", entry("soft"));
    expect(await read(await b.get("k6", ["_N_T_/soft"]))).toBe("soft");
    expect(await b.getExpiration(["_N_T_/soft"])).toBe(0);
    await sleep(5);
    await a.updateTags(["_N_T_/soft"]);
    await waitFor(async () => (await b.getExpiration(["_N_T_/soft"])) > 0);
    expect(await b.get("k6", ["_N_T_/soft"])).toBeUndefined();
    expect(await read(await b.get("k6", ["_N_T_/other"]))).toBe("soft");
    await a.close();
    await b.close();
  });

  it("replaces entries on every handler when another writes the key", async () => {
    const a = createUseCacheHandler(options);
    const b = createUseCacheHandler(options);
    await a.set("k7", entry("one"));
    expect(await read(await b.get("k7", []))).toBe("one");
    await a.set("k7", entry("two"));
    await waitFor(async () => (await read(await b.get("k7", []))) === "two");
    await a.close();
    await b.close();
  });

  it("spills values over the payload limit to the object store", async () => {
    const a = createUseCacheHandler({ ...options, inlineLimit: 4 * 1024 });
    const b = createUseCacheHandler({ ...options, inlineLimit: 4 * 1024 });
    const big = "x".repeat(300_000);
    await a.set("k8", entry(big));
    expect((await read(await b.get("k8", [])))?.length).toBe(big.length);
    await a.set("k8", entry("small".repeat(10)));
    await waitFor(async () => (await read(await b.get("k8", [])))?.length === 50);
    await a.close();
    await b.close();
  });
});

describe("incremental cache handler", () => {
  const Handler = createIncrementalCacheHandler(options);

  it("round trips app page values with buffers and maps", async () => {
    const a = new Handler({ revalidatedTags: [] });
    const value = {
      kind: "APP_PAGE",
      html: "<html></html>",
      rscData: Buffer.from("rsc"),
      headers: { "x-next-cache-tags": "p1,p2" },
      postponed: undefined,
      status: 200,
      segmentData: new Map([["/s", Buffer.from("seg")]]),
    };
    await a.set("/route-cache/APP_PAGE/x/$/p", value as never, { cacheControl: { revalidate: 30, expire: undefined } });
    const b = new Handler({ revalidatedTags: [] });
    const got = await b.get("/route-cache/APP_PAGE/x/$/p", { kind: "APP_PAGE", isFallback: false } as never);
    expect(got?.cacheControl).toEqual({ revalidate: 30 });
    const v = got?.value as typeof value;
    expect(v.rscData.toString()).toBe("rsc");
    expect(v.segmentData.get("/s")?.toString()).toBe("seg");
    await a.close();
    await b.close();
  });

  it("expires pages across handlers when a header tag is revalidated", async () => {
    const a = new Handler({ revalidatedTags: [] });
    const b = new Handler({ revalidatedTags: [] });
    const value = { kind: "APP_ROUTE", body: Buffer.from("b"), status: 200, headers: { "x-next-cache-tags": "isr-tag" } };
    await a.set("route1", value as never, {});
    expect(await b.get("route1", { kind: "APP_ROUTE", isFallback: false } as never)).not.toBeNull();
    await sleep(5);
    await a.revalidateTag("isr-tag");
    await waitFor(async () => (await b.get("route1", { kind: "APP_ROUTE", isFallback: false } as never)) === null);
    await a.close();
    await b.close();
  });

  it("applies fetch cache tags, soft tags and previously revalidated tags", async () => {
    const a = new Handler({ revalidatedTags: [] });
    const b = new Handler({ revalidatedTags: ["prev"] });
    const data = { kind: "FETCH", data: { headers: {}, body: "ZGF0YQ==", url: "u", status: 200 }, revalidate: 60 };
    await a.set("f1", data as never, { fetchCache: true, tags: ["ft"] });
    const ctx = { kind: "FETCH", tags: ["ft"], softTags: [] };
    expect(await b.get("f1", ctx)).not.toBeNull();
    expect(await b.get("f1", { ...ctx, tags: ["prev"] })).toBeNull();
    await sleep(5);
    await a.revalidateTag(["ft"]);
    await waitFor(async () => (await b.get("f1", ctx)) === null);
    await a.set("f1", null, { fetchCache: true });
    await a.close();
    await b.close();
  });
});
