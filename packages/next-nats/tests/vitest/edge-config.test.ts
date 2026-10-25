import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import { createClient, EdgeConfigError, setEdgeConfigItems } from "../../src/edge-config/index.js";

const run = Math.random().toString(36).slice(2, 8);
const BUCKET = `ec_${run}`;
const EMPTY = `ece_${run}`;

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

describe("edge config", () => {
  it("serves an empty bucket", async () => {
    const ec = createClient({ bucket: EMPTY });
    expect(await ec.getAll()).toEqual({});
    expect(await ec.get("x")).toBeUndefined();
    expect(await ec.has("x")).toBe(false);
  });

  it("applies admin writes and rejects invalid operations", async () => {
    await setEdgeConfigItems(
      [
        { operation: "create", key: "greeting", value: "hello" },
        { operation: "upsert", key: "flags:beta", value: { on: true, pct: 25 } },
        { operation: "upsert", key: "list", value: [1, 2, 3] },
      ],
      { bucket: BUCKET },
    );
    await expect(
      setEdgeConfigItems([{ operation: "create", key: "greeting", value: "again" }], { bucket: BUCKET }),
    ).rejects.toBeInstanceOf(EdgeConfigError);
    await expect(
      setEdgeConfigItems([{ operation: "update", key: "missing", value: 1 }], { bucket: BUCKET }),
    ).rejects.toBeInstanceOf(EdgeConfigError);
    await expect(setEdgeConfigItems([{ operation: "delete", key: "missing" }], { bucket: BUCKET })).rejects.toBeInstanceOf(
      EdgeConfigError,
    );
  });

  it("reads from the local mirror", async () => {
    const ec = createClient({ bucket: BUCKET });
    expect(await ec.get("greeting")).toBe("hello");
    expect(await ec.get("flags:beta")).toEqual({ on: true, pct: 25 });
    expect(await ec.has("list")).toBe(true);
    expect(await ec.getAll()).toEqual({ greeting: "hello", "flags:beta": { on: true, pct: 25 }, list: [1, 2, 3] });
    expect(await ec.getAll(["greeting", "nope"])).toEqual({ greeting: "hello" });
  });

  it("propagates changes through the watch", async () => {
    const ec = createClient({ bucket: BUCKET });
    const before = await ec.digest();
    await setEdgeConfigItems([{ operation: "update", key: "greeting", value: "hola" }], { bucket: BUCKET });
    await waitFor(async () => (await ec.get("greeting")) === "hola");
    const after = await ec.digest();
    expect(after).not.toBe(before);
    expect(after).toBe(await ec.digest({ consistentRead: true }));

    await setEdgeConfigItems([{ operation: "delete", key: "list" }], { bucket: BUCKET });
    await waitFor(async () => !(await ec.has("list")));
    expect(await ec.get("list", { consistentRead: true })).toBeUndefined();

    await setEdgeConfigItems([{ operation: "create", key: "new", value: null }], { bucket: BUCKET });
    await waitFor(async () => await ec.has("new"));
    expect(await ec.get("new")).toBeNull();
  });

  it("consistentRead sees writes immediately", async () => {
    const ec = createClient({ bucket: BUCKET });
    await ec.get("greeting");
    await setEdgeConfigItems([{ operation: "upsert", key: "now", value: 1 }], { bucket: BUCKET });
    expect(await ec.get("now", { consistentRead: true })).toBe(1);
    expect(await ec.has("now", { consistentRead: true })).toBe(true);
    expect((await ec.getAll(undefined, { consistentRead: true })) as Record<string, unknown>).toHaveProperty("now", 1);
  });
});
