import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, getNats } from "../src/connection.js";
import { createKv } from "../src/kv/index.js";
import { Ratelimit, toMs } from "../src/ratelimit/index.js";

const run = Math.random().toString(36).slice(2, 8);
const BUCKET = `rl_${run}`;
const kv = createKv({ bucket: BUCKET });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_SERVERS, name: "next-nats-rl-test" });
});

afterAll(async () => {
  const { jsm } = await getNats();
  await jsm.streams.delete(`KV_${BUCKET}`).catch(() => undefined);
  await closeNats();
});

describe("durations", () => {
  it("parses", () => {
    expect(toMs("10 s")).toBe(10_000);
    expect(toMs("1m")).toBe(60_000);
    expect(toMs("250 ms")).toBe(250);
    expect(() => toMs("soon" as never)).toThrow();
  });
});

describe("fixed window", () => {
  it("allows exactly N per window then resets", async () => {
    const rl = new Ratelimit({ kv, limiter: Ratelimit.fixedWindow(3, "1 s"), prefix: "fw" });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await rl.limit("u1"));
    const ok = results.filter((r) => r.success).length;
    expect(ok === 3 || ok === 2).toBe(true);
    expect(results.at(-1)!.success).toBe(false);
    expect(results.at(-1)!.remaining).toBe(0);
    expect(results[0]!.limit).toBe(3);
    await sleep(1100);
    expect((await rl.limit("u1")).success).toBe(true);
  });

  it("is isolated per identifier and supports rate", async () => {
    const rl = new Ratelimit({ kv, limiter: Ratelimit.fixedWindow(10, "1 h"), prefix: "fw2" });
    expect((await rl.limit("a", { rate: 7 })).remaining).toBe(3);
    expect((await rl.limit("a", { rate: 7 })).success).toBe(false);
    expect((await rl.limit("b", { rate: 7 })).success).toBe(true);
  });

  it("is exact under concurrency", async () => {
    const rl = new Ratelimit({ kv, limiter: Ratelimit.fixedWindow(10, "1 h"), prefix: "fw3" });
    const res = await Promise.all(Array.from({ length: 30 }, () => rl.limit("c")));
    expect(res.filter((r) => r.success)).toHaveLength(10);
  });
});

describe("sliding window", () => {
  it("is exact under concurrency", async () => {
    const rl = new Ratelimit({ kv, limiter: Ratelimit.slidingWindow(8, "1 h"), prefix: "sw" });
    const res = await Promise.all(Array.from({ length: 25 }, () => rl.limit("c")));
    expect(res.filter((r) => r.success)).toHaveLength(8);
    expect(res.every((r) => r.reset > Date.now())).toBe(true);
  });

  it("decays the previous window smoothly", async () => {
    const rl = new Ratelimit({ kv, limiter: Ratelimit.slidingWindow(4, "1 s"), prefix: "sw2" });
    await sleep(1000 - (Date.now() % 1000) + 5);
    for (let i = 0; i < 4; i++) await rl.limit("d");
    expect((await rl.limit("d")).success).toBe(false);
    await sleep(2100);
    expect((await rl.getRemaining("d")).remaining).toBe(4);
    expect((await rl.limit("d")).success).toBe(true);
  });

  it("resets used tokens and peeks without consuming", async () => {
    const rl = new Ratelimit({ kv, limiter: Ratelimit.slidingWindow(2, "1 h"), prefix: "sw3" });
    await rl.limit("e");
    expect((await rl.getRemaining("e")).remaining).toBe(1);
    expect((await rl.getRemaining("e")).remaining).toBe(1);
    await rl.resetUsedTokens("e");
    expect((await rl.getRemaining("e")).remaining).toBe(2);
  });
});

describe("token bucket", () => {
  it("drains and refills", async () => {
    const rl = new Ratelimit({ kv, limiter: Ratelimit.tokenBucket(2, "500 ms", 4), prefix: "tb" });
    const first = [];
    for (let i = 0; i < 5; i++) first.push((await rl.limit("t")).success);
    expect(first).toEqual([true, true, true, true, false]);
    await sleep(600);
    const after = await rl.limit("t");
    expect(after.success).toBe(true);
    expect(after.remaining).toBe(1);
  });

  it("is exact under concurrency", async () => {
    const rl = new Ratelimit({ kv, limiter: Ratelimit.tokenBucket(1, "1 h", 6), prefix: "tb2" });
    const res = await Promise.all(Array.from({ length: 20 }, () => rl.limit("c")));
    expect(res.filter((r) => r.success)).toHaveLength(6);
  });

  it("blockUntilReady waits for a refill", async () => {
    const rl = new Ratelimit({ kv, limiter: Ratelimit.tokenBucket(1, "300 ms", 1), prefix: "tb3" });
    await rl.limit("w");
    const started = Date.now();
    const res = await rl.blockUntilReady("w", 2000);
    expect(res.success).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });
});
