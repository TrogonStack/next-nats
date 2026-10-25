import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import { createKv, decodeKey, encodeKey, KvError } from "../../src/kv/index.js";

const run = Math.random().toString(36).slice(2, 8);
const BUCKET = `kvt_${run}`;
const kv = createKv({ bucket: BUCKET });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_SERVERS, name: "next-nats-kv-test" });
});

afterAll(async () => {
  const { jsm } = await getNats();
  await jsm.streams.delete(`KV_${BUCKET}`).catch(() => undefined);
  await closeNats();
});

describe("key encoding", () => {
  it("roundtrips awkward keys", () => {
    for (const k of ["a", "user:1", "a:b:c", ":x", "x:", "a::b", "a.b", "sp ace", "ünï/😀", "*>", "a=b", "=", "."]) {
      const enc = encodeKey(k);
      expect(enc).toMatch(/^[A-Za-z0-9_\-/=.]+$/);
      expect(enc.startsWith(".")).toBe(false);
      expect(enc.endsWith(".")).toBe(false);
      expect(decodeKey(enc)).toBe(k);
    }
  });

  it("maps colons between segments to subject tokens", () => {
    expect(encodeKey("user:42:name")).toBe("user.42.name");
  });
});

describe("strings", () => {
  it("get/set/del/exists", async () => {
    expect(await kv.get("s:missing")).toBeNull();
    expect(await kv.set("s:a", { n: 1, tags: ["x"] })).toBe("OK");
    expect(await kv.get("s:a")).toEqual({ n: 1, tags: ["x"] });
    expect(await kv.exists("s:a", "s:missing", "s:a")).toBe(2);
    expect(await kv.del("s:a", "s:missing")).toBe(1);
    expect(await kv.get("s:a")).toBeNull();
    expect(await kv.set("s:a", "again")).toBe("OK");
    expect(await kv.get("s:a")).toBe("again");
  });

  it("nx / xx / get / keepTtl", async () => {
    expect(await kv.set("o:a", 1, { nx: true })).toBe("OK");
    expect(await kv.set("o:a", 2, { nx: true })).toBeNull();
    expect(await kv.get("o:a")).toBe(1);
    expect(await kv.set("o:b", 1, { xx: true })).toBeNull();
    expect(await kv.get("o:b")).toBeNull();
    expect(await kv.set("o:a", 3, { xx: true })).toBe("OK");
    expect(await kv.set("o:a", 4, { get: true })).toBe(3);
    await kv.set("o:ttl", "v", { ex: 100 });
    await kv.set("o:ttl", "w", { keepTtl: true });
    expect(await kv.ttl("o:ttl")).toBeGreaterThan(90);
    await kv.set("o:ttl", "z");
    expect(await kv.ttl("o:ttl")).toBe(-1);
  });

  it("getdel, getset, setnx, mget, mset", async () => {
    await kv.set("g:a", "x");
    expect(await kv.getset("g:a", "y")).toBe("x");
    expect(await kv.getdel("g:a")).toBe("y");
    expect(await kv.getdel("g:a")).toBeNull();
    expect(await kv.setnx("g:n", 1)).toBe(1);
    expect(await kv.setnx("g:n", 2)).toBe(0);
    await kv.mset({ "m:1": 1, "m:2": "two" });
    expect(await kv.mget("m:1", "m:2", "m:3")).toEqual([1, "two", null]);
    expect(await kv.mget(["m:1", "m:2"])).toEqual([1, "two"]);
  });
});

describe("counters", () => {
  it("incr family", async () => {
    expect(await kv.incr("c:a")).toBe(1);
    expect(await kv.incrby("c:a", 10)).toBe(11);
    expect(await kv.decr("c:a")).toBe(10);
    expect(await kv.decrby("c:a", 4)).toBe(6);
    expect(await kv.incrbyfloat("c:f", 1.5)).toBe(1.5);
    await kv.set("c:s", "41");
    expect(await kv.incr("c:s")).toBe(42);
    await kv.set("c:bad", "abc");
    await expect(kv.incr("c:bad")).rejects.toBeInstanceOf(KvError);
  });

  it("concurrent incr is exact under CAS contention", async () => {
    const n = 100;
    await Promise.all(Array.from({ length: n }, () => kv.incr("c:race")));
    expect(await kv.get("c:race")).toBe(n);
  });

  it("concurrent hincrby is exact", async () => {
    await Promise.all(Array.from({ length: 40 }, () => kv.hincrby("c:hrace", "f", 2)));
    expect(await kv.hget("c:hrace", "f")).toBe(80);
  });

  it("concurrent nx has a single winner", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => kv.set("c:nx", i, { nx: true })));
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
  });
});

describe("ttl", () => {
  it("reports and clears ttl", async () => {
    await kv.set("t:a", 1);
    expect(await kv.ttl("t:a")).toBe(-1);
    expect(await kv.ttl("t:none")).toBe(-2);
    expect(await kv.expire("t:a", 100)).toBe(1);
    expect(await kv.ttl("t:a")).toBeGreaterThan(95);
    expect(await kv.pttl("t:a")).toBeGreaterThan(95_000);
    expect(await kv.expire("t:a", 50, "GT")).toBe(0);
    expect(await kv.expire("t:a", 50, "LT")).toBe(1);
    expect(await kv.persist("t:a")).toBe(1);
    expect(await kv.ttl("t:a")).toBe(-1);
    expect(await kv.expire("t:none", 10)).toBe(0);
  });

  it("expires keys with millisecond precision", async () => {
    await kv.set("t:px", "v", { px: 300 });
    expect(await kv.get("t:px")).toBe("v");
    await sleep(450);
    expect(await kv.get("t:px")).toBeNull();
    expect(await kv.exists("t:px")).toBe(0);
    expect(await kv.keys("t:px")).toEqual([]);
    expect(await kv.set("t:px", "again", { nx: true })).toBe("OK");
  });

  it("is removed by the server natively", async () => {
    expect(await kv.store.nativeTtl).toBe(true);
    await kv.set("t:native", "v", { ex: 1 });
    await sleep(2500);
    const bucket = await kv.store.kv();
    const entry = await bucket.get(encodeKey("t:native"));
    expect(entry === null || entry.operation !== "PUT").toBe(true);
  });

  it("counters keep their ttl", async () => {
    await kv.set("t:c", 1, { ex: 100 });
    await kv.incr("t:c");
    expect(await kv.ttl("t:c")).toBeGreaterThan(90);
  });

  it("past expiry deletes", async () => {
    await kv.set("t:past", 1);
    expect(await kv.pexpire("t:past", -1)).toBe(1);
    expect(await kv.get("t:past")).toBeNull();
  });
});

describe("keys and scan", () => {
  it("matches globs", async () => {
    await kv.mset({ "k:a:1": 1, "k:a:2": 2, "k:b:1": 3, "k.odd": 4 });
    expect((await kv.keys("k:a:*")).sort()).toEqual(["k:a:1", "k:a:2"]);
    expect((await kv.keys("k:?:1")).sort()).toEqual(["k:a:1", "k:b:1"]);
    expect((await kv.keys("k:[ab]:1")).sort()).toEqual(["k:a:1", "k:b:1"]);
    expect(await kv.keys("k.odd")).toEqual(["k.odd"]);
  });

  it("scans in pages", async () => {
    const seen: string[] = [];
    let cursor = "0";
    do {
      const [next, page] = await kv.scan(cursor, { match: "k:*", count: 2 });
      seen.push(...page);
      cursor = next;
    } while (cursor !== "0");
    expect(seen.sort()).toEqual(["k:a:1", "k:a:2", "k:b:1"]);
  });
});

describe("hashes", () => {
  it("covers the hash family", async () => {
    expect(await kv.hset("h:a", { name: "ada", age: 36 })).toBe(2);
    expect(await kv.hset("h:a", { age: 37, role: "eng" })).toBe(1);
    expect(await kv.hget("h:a", "name")).toBe("ada");
    expect(await kv.hget("h:a", "nope")).toBeNull();
    expect(await kv.hgetall("h:a")).toEqual({ name: "ada", age: 37, role: "eng" });
    expect(await kv.hmget("h:a", "name", "role")).toEqual({ name: "ada", role: "eng" });
    expect(await kv.hincrby("h:a", "age", 3)).toBe(40);
    expect(await kv.hexists("h:a", "role")).toBe(1);
    expect((await kv.hkeys("h:a")).sort()).toEqual(["age", "name", "role"]);
    expect(await kv.hlen("h:a")).toBe(3);
    expect(await kv.hsetnx("h:a", "name", "x")).toBe(0);
    expect(await kv.hdel("h:a", "role", "ghost")).toBe(1);
    expect(await kv.hdel("h:a", "name", "age")).toBe(2);
    expect(await kv.hgetall("h:a")).toBeNull();
    expect(await kv.exists("h:a")).toBe(0);
  });

  it("raises WRONGTYPE", async () => {
    await kv.set("w:s", 1);
    await kv.hset("w:h", { a: 1 });
    await expect(kv.hget("w:s", "a")).rejects.toThrow(/WRONGTYPE/);
    await expect(kv.get("w:h")).rejects.toThrow(/WRONGTYPE/);
    expect(await kv.type("w:h")).toBe("hash");
  });

  it("flushdb empties the bucket", async () => {
    await kv.flushdb();
    expect(await kv.dbsize()).toBe(0);
  });
});
