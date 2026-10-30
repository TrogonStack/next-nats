import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import { UpstashError } from "../../src/kv/errors.js";
import { Redis } from "../../src/redis/index.js";

const BUCKET = `nonatomic_${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_URL, name: "next-nats-non-atomic-test" });
});

afterAll(async () => {
  const { jsm } = await getNats();
  await jsm.streams.delete(`KV_${BUCKET}`).catch(() => undefined);
  await closeNats();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function nonAtomicClient(): Promise<Redis> {
  const { jsm } = await getNats();
  vi.spyOn(jsm.streams, "update").mockRejectedValue(new Error("stream updates are blocked"));
  const redis = new Redis({ bucket: BUCKET });
  await redis.set("probe", "1");
  const info = await jsm.streams.info(`KV_${BUCKET}`);
  expect(info.config.allow_atomic).not.toBe(true);
  return redis;
}

describe("a bucket without atomic batch support", () => {
  it("refuses multi() instead of running its commands one by one", async () => {
    const redis = await nonAtomicClient();
    await expect(redis.multi().set("a", "1").set("b", "2").exec()).rejects.toThrow(UpstashError);
    expect(await redis.get("a")).toBeNull();
    expect(await redis.get("b")).toBeNull();
  });

  it("refuses multi-key commands", async () => {
    const redis = await nonAtomicClient();
    await redis.sadd("src", "x");
    await expect(redis.sunionstore("dst", "src")).rejects.toThrow(/atomic/);
    await expect(redis.rename("src", "moved")).rejects.toThrow(/atomic/);
    expect(await redis.smembers("src")).toEqual(["x"]);
    expect(await redis.smembers("dst")).toEqual([]);
  });

  it("keeps single-key commands and pipeline() working", async () => {
    const redis = await nonAtomicClient();
    await redis.set("plain", "v");
    expect(await redis.get("plain")).toBe("v");
    expect(await redis.pipeline().set("p1", "1").set("p2", "2").get("p1").exec()).toEqual(["OK", "OK", 1]);
  });
});
