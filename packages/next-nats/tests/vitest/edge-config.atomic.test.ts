import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeNats, connectNats, getNats, openKv } from "../../src/connection.js";
import { createClient, EdgeConfigError, updateEdgeConfigItems } from "../../src/edge-config/index.js";
import { encodeKey } from "../../src/kv/key.js";

const BUCKET = `eca_${Math.random().toString(36).slice(2, 8)}`;
const conn = `edge-config:id=${BUCKET}`;
const encoder = new TextEncoder();

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_SERVERS, name: "next-nats-ec-atomic-test" });
});

afterAll(async () => {
  const { jsm } = await getNats();
  await jsm.streams.delete(`KV_${BUCKET}`).catch(() => undefined);
  await closeNats();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function afterFirstReads(key: string, times: number, hook: (n: number) => Promise<unknown>) {
  const kv = await openKv(BUCKET);
  const original = kv.get.bind(kv);
  let fired = 0;
  vi.spyOn(kv, "get").mockImplementation(async (k: string, ...rest: [] | [number]) => {
    const entry = await original(k, ...(rest as []));
    if (fired < times && k === encodeKey(key)) {
      fired++;
      await hook(fired);
    }
    return entry;
  });
  return kv;
}

const put = async (key: string, value: unknown) => (await openKv(BUCKET)).put(encodeKey(key), encoder.encode(JSON.stringify(value)));
const del = async (key: string) => (await openKv(BUCKET)).delete(encodeKey(key));
const read = async (key: string) => createClient(conn).get(key, { consistentRead: true });

describe("updateEdgeConfigItems is atomic", () => {
  it("writes nothing when a concurrent create makes a later item invalid", async () => {
    await put("seed1", "old");
    await afterFirstReads("clash1", 1, () => put("clash1", "theirs"));
    await expect(
      updateEdgeConfigItems(conn, {
        items: [
          { operation: "upsert", key: "seed1", value: "new" },
          { operation: "create", key: "clash1", value: "mine" },
        ],
      }),
    ).rejects.toThrow(EdgeConfigError);
    expect(await read("seed1")).toBe("old");
    expect(await read("clash1")).toBe("theirs");
  });

  it("deletes nothing when a concurrent delete makes a later update invalid", async () => {
    await put("keep2", "kept");
    await put("gone2", "x");
    await afterFirstReads("gone2", 1, () => del("gone2"));
    await expect(
      updateEdgeConfigItems(conn, {
        items: [
          { operation: "delete", key: "keep2" },
          { operation: "update", key: "gone2", value: "y" },
        ],
      }),
    ).rejects.toThrow(/Cannot update missing item "gone2"/);
    expect(await read("keep2")).toBe("kept");
  });

  it("revalidates and retries instead of failing when a concurrent write changes an updated item", async () => {
    await put("moving3", 1);
    await afterFirstReads("moving3", 2, (n) => put("moving3", 1 + n));
    await expect(updateEdgeConfigItems(conn, { items: [{ operation: "update", key: "moving3", value: 3 }] })).resolves.toEqual({ status: "ok" });
    expect(await read("moving3")).toBe(3);
  });

  it("still deletes the item and applies its siblings when a concurrent write lands after the read", async () => {
    await put("anchor4", "a");
    await put("target4", "old");
    await afterFirstReads("target4", 2, () => put("target4", "newer"));
    await updateEdgeConfigItems(conn, {
      items: [
        { operation: "delete", key: "target4" },
        { operation: "update", key: "anchor4", value: "b" },
      ],
    });
    expect(await read("target4")).toBeUndefined();
    expect(await read("anchor4")).toBe("b");
  });

  it("applies a valid batch of mixed operations", async () => {
    await put("upd5", 1);
    await put("rm5", 1);
    await updateEdgeConfigItems(conn, {
      items: [
        { operation: "create", key: "new5", value: { a: 1 } },
        { operation: "update", key: "upd5", value: 2 },
        { operation: "delete", key: "rm5" },
        { operation: "upsert", key: "ups5", value: [1] },
      ],
    });
    expect(await read("new5")).toEqual({ a: 1 });
    expect(await read("upd5")).toBe(2);
    expect(await read("rm5")).toBeUndefined();
    expect(await read("ups5")).toEqual([1]);
  });
});
