import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import { Redis as UpstashRedis } from "@upstash/redis";
import { decodeKey, encodeKey } from "../../src/kv/index.js";
import { Redis, errors } from "../../src/redis/index.js";
import { internals } from "../../src/redis/redis.js";

const run = Math.random().toString(36).slice(2, 8);
const BUCKET = `kvt_${run}`;
const kv = new Redis({ bucket: BUCKET });
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
    await expect(kv.incr("c:bad")).rejects.toBeInstanceOf(errors.UpstashError);
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
    expect(await kv[internals].store.nativeTtl).toBe(true);
    await kv.set("t:native", "v", { ex: 1 });
    await sleep(2500);
    const bucket = await kv[internals].store.kv();
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

describe("type parity with @upstash/redis", () => {
  type Ours = Redis;
  type Theirs = UpstashRedis;
  const methods = [
    "get", "set", "setnx", "setex", "psetex", "getset", "getdel", "getex", "mget", "mset", "msetnx",
    "append", "strlen", "getrange", "setrange", "incr", "incrby", "incrbyfloat", "decr", "decrby",
    "del", "unlink", "exists", "touch", "expire", "pexpire", "expireat", "pexpireat", "persist",
    "ttl", "pttl", "type", "rename", "renamenx", "copy", "keys", "scan", "randomkey", "dbsize",
    "flushdb", "flushall", "ping", "echo", "time",
    "hset", "hmset", "hsetnx", "hget", "hgetall", "hmget", "hdel", "hincrby", "hincrbyfloat",
    "hexists", "hkeys", "hvals", "hlen", "hstrlen", "hrandfield", "hscan",
    "lpush", "rpush", "lpushx", "rpushx", "lpop", "rpop", "llen", "lindex", "lrange", "lset", "lrem",
    "ltrim", "linsert", "lmove", "lpos",
    "sadd", "srem", "sismember", "smismember", "smembers", "scard", "spop", "srandmember", "smove",
    "sdiff", "sdiffstore", "sinter", "sinterstore", "sunion", "sunionstore", "sintercard", "sscan",
    "zadd", "zcard", "zcount", "zlexcount", "zincrby", "zscore", "zmscore", "zrank", "zrevrank", "zrem",
    "zrange", "zpopmin", "zpopmax", "zremrangebyrank", "zremrangebyscore", "zremrangebylex", "zunion",
    "zunionstore", "zinterstore", "zdiffstore", "zscan", "pipeline", "multi",
  ] as const satisfies readonly (keyof Ours & keyof Theirs)[];

  it("exposes every implemented method as a function", () => {
    for (const m of methods) expect(typeof kv[m]).toBe("function");
  });

  it("keeps common return shapes", () => {
    expectTypeOf<Awaited<ReturnType<Ours["get"]>>>().toEqualTypeOf<Awaited<ReturnType<Theirs["get"]>>>();
    expectTypeOf<Awaited<ReturnType<Ours["incr"]>>>().toEqualTypeOf<number>();
    expectTypeOf<Awaited<ReturnType<Ours["hgetall"]>>>().toEqualTypeOf<Awaited<ReturnType<Theirs["hgetall"]>>>();
    expectTypeOf<Awaited<ReturnType<Ours["ttl"]>>>().toEqualTypeOf<number>();
    expectTypeOf<Awaited<ReturnType<Ours["smembers"]>>>().toEqualTypeOf<Awaited<ReturnType<Theirs["smembers"]>>>();
    expectTypeOf<Awaited<ReturnType<Ours["scan"]>>>().toEqualTypeOf<Awaited<ReturnType<Theirs["scan"]>>>();
  });

  it("accepts the same set options", () => {
    expectTypeOf<Parameters<Ours["set"]>[2]>().toEqualTypeOf<Parameters<Theirs["set"]>[2]>();
  });
});

describe("collections", () => {
  it("lists", async () => {
    expect(await kv.rpush("l:a", "x", "y", "z")).toBe(3);
    expect(await kv.lpush("l:a", "w")).toBe(4);
    expect(await kv.lrange("l:a", 0, -1)).toEqual(["w", "x", "y", "z"]);
    expect(await kv.lpop("l:a")).toBe("w");
    expect(await kv.rpop("l:a")).toBe("z");
    expect(await kv.llen("l:a")).toBe(2);
    expect(await kv.lindex("l:a", 1)).toBe("y");
  });

  it("sets", async () => {
    expect(await kv.sadd("st:a", "1", "2", "3")).toBe(3);
    expect(await kv.sadd("st:b", "2", "3", "4")).toBe(3);
    expect((await kv.sinter("st:a", "st:b")).sort()).toEqual([2, 3]);
    expect((await kv.sunion("st:a", "st:b")).sort()).toEqual([1, 2, 3, 4]);
    expect(await kv.sdiff("st:a", "st:b")).toEqual([1]);
    expect(await kv.sismember("st:a", "1")).toBe(1);
    expect(await kv.scard("st:a")).toBe(3);
  });

  it("sorted sets", async () => {
    expect(await kv.zadd("z:a", { score: 1, member: "a" }, { score: 3, member: "c" }, { score: 2, member: "b" })).toBe(3);
    expect(await kv.zrange("z:a", 0, -1)).toEqual(["a", "b", "c"]);
    expect(await kv.zrange("z:a", 0, -1, { rev: true })).toEqual(["c", "b", "a"]);
    expect(await kv.zrange("z:a", 0, 1, { withScores: true })).toEqual(["a", 1, "b", 2]);
    expect(await kv.zscore("z:a", "b")).toBe(2);
    expect(await kv.zrank("z:a", "c")).toBe(2);
    expect(await kv.zincrby("z:a", 5, "a")).toBe(6);
    expect(await kv.zpopmin("z:a", 1)).toEqual(["b", 2]);
  });
});

describe("pipeline and multi", () => {
  it("runs queued commands in order and returns results", async () => {
    const res = await kv.pipeline().set("p:a", 1).incr("p:a").get("p:a").exec();
    expect(res).toEqual(["OK", 2, 2]);
    const tx = await kv.multi().hset("p:h", { f: "v" }).hget("p:h", "f").exec();
    expect(tx).toEqual([1, "v"]);
  });
});

describe("unsupported", () => {
  it("scripting throws a clear error", async () => {
    await expect(kv.eval("return 1", [], [])).rejects.toBeInstanceOf(errors.UnsupportedCommandError);
  });
});

describe("atomic multi-key operations", () => {
  it("msetnx has a single winner and never leaves a partial write", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => kv.msetnx({ "tx:m:a": i, "tx:m:b": i, "tx:m:c": i })),
    );
    expect(results.filter((r) => r === 1)).toHaveLength(1);
    const [a, b, c] = await kv.mget<number[]>("tx:m:a", "tx:m:b", "tx:m:c");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("concurrent mset leaves every key from the same writer", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => kv.mset({ "tx:w:p": i, "tx:w:q": i, "tx:w:r": i })));
    const [p, q, r] = await kv.mget<number[]>("tx:w:p", "tx:w:q", "tx:w:r");
    expect(q).toBe(p);
    expect(r).toBe(p);
  });

  it("msetnx fails as a whole when one key exists", async () => {
    await kv.set("tx:n:b", "taken");
    expect(await kv.msetnx({ "tx:n:a": 1, "tx:n:b": 2, "tx:n:c": 3 })).toBe(0);
    expect(await kv.exists("tx:n:a", "tx:n:c")).toBe(0);
  });

  it("multi transfers keep the total exact under contention", async () => {
    await kv.mset({ "tx:acct:x": 100, "tx:acct:y": 0 });
    await Promise.all(
      Array.from({ length: 30 }, () => kv.multi().decrby("tx:acct:x", 1).incrby("tx:acct:y", 1).exec()),
    );
    expect(await kv.get("tx:acct:x")).toBe(70);
    expect(await kv.get("tx:acct:y")).toBe(30);
  });

  it("multi applies nothing when a conflicting writer wins and retries to a consistent result", async () => {
    await kv.set("tx:c:a", 0);
    await kv.set("tx:c:b", 0);
    const mixed = await Promise.all([
      ...Array.from({ length: 15 }, () => kv.multi().incr("tx:c:a").incr("tx:c:b").exec()),
      ...Array.from({ length: 15 }, () => kv.incr("tx:c:a")),
    ]);
    expect(mixed).toHaveLength(30);
    expect(await kv.get("tx:c:a")).toBe(30);
    expect(await kv.get("tx:c:b")).toBe(15);
  });

  it("smove keeps a member in exactly one set", async () => {
    await kv.sadd("tx:s:from", ..."abcdefghij".split("") as [string, ...string[]]);
    await Promise.all("abcdefghij".split("").map((m) => kv.smove("tx:s:from", "tx:s:to", m)));
    expect(await kv.scard("tx:s:from")).toBe(0);
    expect(await kv.scard("tx:s:to")).toBe(10);
  });

  it("lmove never duplicates or drops elements", async () => {
    await kv.rpush("tx:l:from", ...(Array.from({ length: 15 }, (_, i) => `e${i}`) as [string, ...string[]]));
    await Promise.all(Array.from({ length: 15 }, () => kv.lmove("tx:l:from", "tx:l:to", "left", "right")));
    expect(await kv.llen("tx:l:from")).toBe(0);
    expect(((await kv.lrange("tx:l:to", 0, -1)) as string[]).sort()).toEqual(
      Array.from({ length: 15 }, (_, i) => `e${i}`).sort(),
    );
  });

  it("rename moves a value atomically and keeps its ttl", async () => {
    await kv.set("tx:r:src", "v", { ex: 100 });
    await Promise.all([kv.rename("tx:r:src", "tx:r:dst"), kv.get("tx:r:src"), kv.get("tx:r:dst")]);
    expect(await kv.get("tx:r:dst")).toBe("v");
    expect(await kv.exists("tx:r:src")).toBe(0);
    expect(await kv.ttl("tx:r:dst")).toBeGreaterThan(90);
  });

  it("multi reports per command errors without discarding the other commands", async () => {
    await kv.set("tx:e:str", "x");
    const res = await kv.multi().set("tx:e:ok", 1).hget("tx:e:str", "f").exec({ keepErrors: true });
    expect(res[0]).toEqual({ result: "OK" });
    expect(res[1]?.error).toBeDefined();
    expect(await kv.get("tx:e:ok")).toBe(1);
    await expect(kv.multi().incr("tx:e:ok").hget("tx:e:str", "f").exec()).rejects.toBeInstanceOf(errors.UpstashError);
  });
});
