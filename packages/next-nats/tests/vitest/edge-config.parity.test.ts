import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import * as real from "@vercel/edge-config";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import * as ours from "../../src/edge-config/index.js";
import { createClient, EdgeConfigError, parseConnectionString, updateEdgeConfigItems } from "../../src/edge-config/index.js";

const run = Math.random().toString(36).slice(2, 8);
const BUCKET = `ec_${run}`;
const EMPTY = `ece_${run}`;
const conn = (bucket: string) => `edge-config:id=${bucket}`;

async function waitFor(fn: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_SERVERS, name: "next-nats-ec-test" });
});

afterAll(async () => {
  const { jsm } = await getNats();
  for (const b of [BUCKET, EMPTY]) await jsm.streams.delete(`KV_${b}`).catch(() => undefined);
  await closeNats();
});

describe("edge config type parity with @vercel/edge-config@1.5.1", () => {
  it("exports every runtime name of the real package", () => {
    for (const name of Object.keys(real)) expect(ours, name).toHaveProperty(name);
  });

  it("matches signatures", () => {
    expectTypeOf<typeof ours.createClient>().parameters.toEqualTypeOf<Parameters<typeof real.createClient>>();
    expectTypeOf<typeof ours.get>().toEqualTypeOf<(typeof real)["get"]>();
    expectTypeOf<typeof ours.getAll>().toEqualTypeOf<(typeof real)["getAll"]>();
    expectTypeOf<typeof ours.has>().toEqualTypeOf<(typeof real)["has"]>();
    expectTypeOf<typeof ours.digest>().toEqualTypeOf<(typeof real)["digest"]>();
    expectTypeOf<typeof ours.parseConnectionString>().toEqualTypeOf<typeof real.parseConnectionString>();
    expectTypeOf<typeof ours.clone>().toEqualTypeOf<typeof real.clone>();
    expectTypeOf<ours.EdgeConfigValue>().toEqualTypeOf<real.EdgeConfigValue>();
    expectTypeOf<ours.EdgeConfigItems>().toEqualTypeOf<real.EdgeConfigItems>();
    expectTypeOf<ours.EmbeddedEdgeConfig>().toEqualTypeOf<real.EmbeddedEdgeConfig>();
    expectTypeOf<ours.EdgeConfigClientOptions>().toEqualTypeOf<NonNullable<Parameters<typeof real.createClient>[1]>>();
    expectTypeOf<ours.EdgeConfigClient>().toExtend<real.EdgeConfigClient>();
    expectTypeOf<ReturnType<typeof ours.parseConnectionString>>().toEqualTypeOf<ReturnType<typeof real.parseConnectionString>>();
  });

  it("accepts the real tracer provider type", () => {
    expectTypeOf<Parameters<typeof real.setTracerProvider>[0]>().toExtend<Parameters<typeof ours.setTracerProvider>[0]>();
  });
});

describe("edge config behavior", () => {
  it("parses the connection string and rejects bad ones", () => {
    expect(parseConnectionString("edge-config:id=my-bucket&token=t")).toEqual({
      type: "external",
      baseUrl: "edge-config:my-bucket",
      id: "my-bucket",
      token: "t",
      version: "1",
    });
    expect(parseConnectionString("https://example.com")).toBeNull();
    expect(parseConnectionString("edge-config:token=t")).toBeNull();
    expect(() => createClient(undefined)).toThrow("@vercel/edge-config: No connection string provided");
    expect(() => createClient("nope")).toThrow("@vercel/edge-config: Invalid connection string provided");
    expect(createClient(conn("x"), { staleIfError: false, cache: "force-cache" }).connection.id).toBe("x");
  });

  it("serves an empty bucket", async () => {
    const ec = createClient(conn(EMPTY));
    expect(await ec.getAll()).toEqual({});
    expect(await ec.get("x")).toBeUndefined();
    expect(await ec.has("x")).toBe(false);
    expect(await ec.has("  ")).toBe(false);
    await expect(ec.get(1 as unknown as string)).rejects.toThrow("Expected key to be a string");
    await expect(ec.getAll("a" as never)).rejects.toThrow("Expected keys to be an array of string");
  });

  it("applies update operations and rejects invalid ones", async () => {
    const result = await updateEdgeConfigItems(conn(BUCKET), {
      items: [
        { operation: "create", key: "greeting", value: "hello" },
        { operation: "upsert", key: "flags:beta", value: { on: true, pct: 25 } },
        { operation: "upsert", key: "list", value: [1, 2, 3] },
      ],
    });
    expect(result).toEqual({ status: "ok" });
    await expect(
      updateEdgeConfigItems(conn(BUCKET), { items: [{ operation: "create", key: "greeting", value: "again" }] }),
    ).rejects.toBeInstanceOf(EdgeConfigError);
    await expect(
      updateEdgeConfigItems(conn(BUCKET), { items: [{ operation: "update", key: "missing", value: 1 }] }),
    ).rejects.toBeInstanceOf(EdgeConfigError);
    await expect(
      updateEdgeConfigItems(conn(BUCKET), { items: [{ operation: "delete", key: "missing" }] }),
    ).rejects.toBeInstanceOf(EdgeConfigError);
  });

  it("reads from the local mirror", async () => {
    const ec = createClient(conn(BUCKET));
    expect(await ec.get("greeting")).toBe("hello");
    expect(await ec.get("flags:beta")).toEqual({ on: true, pct: 25 });
    expect(await ec.has("list")).toBe(true);
    expect(await ec.getAll()).toEqual({ greeting: "hello", "flags:beta": { on: true, pct: 25 }, list: [1, 2, 3] });
    expect(await ec.getAll(["greeting", "nope"])).toEqual({ greeting: "hello" });
  });

  it("returns values the caller may mutate", async () => {
    const ec = createClient(conn(BUCKET));
    const flags = (await ec.get<{ on: boolean }>("flags:beta"))!;
    flags.on = false;
    expect((await ec.get<{ on: boolean }>("flags:beta"))!.on).toBe(true);
  });

  it("propagates changes through the watch", async () => {
    const ec = createClient(conn(BUCKET));
    const before = await ec.digest();
    await updateEdgeConfigItems(conn(BUCKET), { items: [{ operation: "update", key: "greeting", value: "hola" }] });
    await waitFor(async () => (await ec.get("greeting")) === "hola");
    const after = await ec.digest();
    expect(after).not.toBe(before);
    expect(after).toBe(await ec.digest({ consistentRead: true }));

    await updateEdgeConfigItems(conn(BUCKET), { items: [{ operation: "delete", key: "list" }] });
    await waitFor(async () => !(await ec.has("list")));
    expect(await ec.get("list", { consistentRead: true })).toBeUndefined();

    await updateEdgeConfigItems(conn(BUCKET), { items: [{ operation: "create", key: "new", value: null }] });
    await waitFor(async () => await ec.has("new"));
    expect(await ec.get("new")).toBeNull();
  });

  it("consistentRead sees writes immediately", async () => {
    const ec = createClient(conn(BUCKET));
    await ec.get("greeting");
    await updateEdgeConfigItems(conn(BUCKET), { items: [{ operation: "upsert", key: "now", value: 1 }] });
    expect(await ec.get("now", { consistentRead: true })).toBe(1);
    expect(await ec.has("now", { consistentRead: true })).toBe(true);
    expect((await ec.getAll(undefined, { consistentRead: true })) as Record<string, unknown>).toHaveProperty("now", 1);
  });

  it("default client reads EDGE_CONFIG", async () => {
    process.env.EDGE_CONFIG = conn(BUCKET);
    vi.resetModules();
    const mod = await import("../../src/edge-config/index.js");
    expect(await mod.get("greeting")).toBe("hola");
    delete process.env.EDGE_CONFIG;
  });
});
