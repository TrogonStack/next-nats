import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import { KvStore } from "../../src/kv/store.js";
import { Redis } from "../../src/redis/index.js";

const BUCKET = `txn_${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_URL, name: "next-nats-transaction-test" });
});

afterAll(async () => {
  const { jsm } = await getNats();
  await jsm.streams.delete(`KV_${BUCKET}`).catch(() => undefined);
  await closeNats();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function interleave(beforeFirstCommit: () => Promise<unknown>) {
  const original = KvStore.prototype.commit;
  let calls = 0;
  const spy = vi.spyOn(KvStore.prototype, "commit").mockImplementation(async function (this: KvStore, ...args) {
    if (calls++ === 0) await beforeFirstCommit();
    return original.apply(this, args);
  });
  return spy;
}

const names = (() => {
  let n = 0;
  return (label: string) => `${label}:${++n}:${Math.random().toString(36).slice(2, 8)}`;
})();

describe("transactions validate the keys they only read", () => {
  it("retries when a key that was read and not written changes before commit", async () => {
    const redis = new Redis({ bucket: BUCKET });
    const other = new Redis({ bucket: BUCKET });
    const [a, b] = [names("a"), names("b")];
    await redis.sadd(a, "x");
    const spy = interleave(() => other.sadd(a, "y"));
    await redis.sunionstore(b, a);
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await redis.smembers(b)).sort()).toEqual(["x", "y"]);
  });

  it("retries when a key that was read as missing is created before commit", async () => {
    const redis = new Redis({ bucket: BUCKET });
    const other = new Redis({ bucket: BUCKET });
    const [a, b] = [names("a"), names("b")];
    await redis.sadd(b, "stale");
    const spy = interleave(() => other.sadd(a, "y"));
    await redis.sunionstore(b, a);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await redis.smembers(b)).toEqual(["y"]);
  });

  it("retries when a key that was read as deleted is recreated before commit", async () => {
    const redis = new Redis({ bucket: BUCKET });
    const other = new Redis({ bucket: BUCKET });
    const [a, b] = [names("a"), names("b")];
    await redis.sadd(a, "old");
    await redis.del(a);
    await redis.sadd(b, "stale");
    const spy = interleave(() => other.sadd(a, "y"));
    await redis.sunionstore(b, a);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await redis.smembers(b)).toEqual(["y"]);
  });

  it("retries a multi() whose read-only key changes before exec", async () => {
    const redis = new Redis({ bucket: BUCKET });
    const other = new Redis({ bucket: BUCKET });
    const [a, b] = [names("a"), names("b")];
    await redis.sadd(a, "x");
    const spy = interleave(() => other.sadd(a, "y"));
    await redis.multi().sunionstore(b, a).exec();
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await redis.smembers(b)).sort()).toEqual(["x", "y"]);
  });

  it("never lets concurrent swaps produce a state no serial order allows", async () => {
    const x = new Redis({ bucket: BUCKET });
    const y = new Redis({ bucket: BUCKET });
    const [a, b] = [names("a"), names("b")];
    await x.sadd(a, "from-a");
    await x.sadd(b, "from-b");
    const original = KvStore.prototype.commit;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    vi.spyOn(KvStore.prototype, "commit").mockImplementation(async function (this: KvStore, ...args) {
      if (waiting < 2) {
        waiting++;
        if (waiting === 2) release();
        await gate;
      }
      return original.apply(this, args);
    });
    await Promise.all([x.sunionstore(b, a), y.sunionstore(a, b)]);
    const [sa, sb] = [(await x.smembers(a)).sort(), (await x.smembers(b)).sort()];
    const serialAB = [["from-a"], ["from-a"]];
    const serialBA = [["from-b"], ["from-b"]];
    expect([sa, sb]).toSatisfy((got: string[][]) => [serialAB, serialBA].some((s) => JSON.stringify(s) === JSON.stringify(got)));
  });
});
