import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stripWireSuffix } from "./redis-commands.js";
import { openPair, requireProxy, settle as rawSettle } from "./redis-harness.js";
import type { Outcome, Pair } from "./redis-harness.js";

const available = await requireProxy();

async function settle(run: () => Promise<unknown>): Promise<Outcome> {
  const outcome = await rawSettle(run);
  return outcome.ok ? outcome : { ...outcome, message: stripWireSuffix(outcome.message) };
}

type Client = Pair["real"] | Pair["ours"];

describe.skipIf(!available)("redis edge cases differential against @upstash/redis", () => {
  let pair: Pair;
  beforeAll(async () => {
    pair = await openPair();
  });
  afterAll(async () => {
    await pair.close();
  });
  beforeEach(async () => {
    await pair.reset();
  });

  async function same(script: (client: Client) => Promise<unknown>) {
    const real = await settle(() => script(pair.real));
    const ours = await settle(() => script(pair.ours));
    expect(ours).toEqual(real);
    return real;
  }

  describe("expiry", () => {
    const bucketed = (ttl: number) => (ttl > 0 ? "positive" : ttl);

    it("set with every expiry option reports the same ttl class", async () => {
      const now = Date.now();
      for (const options of [{ ex: 100 }, { px: 100_000 }, { exat: Math.floor(now / 1000) + 100 }, { pxat: now + 100_000 }, { ex: 100, nx: true }]) {
        await same(async (c) => {
          await c.set("t", "v", options as never);
          return [bucketed(await c.ttl("t")), bucketed(await c.pttl("t"))];
        });
      }
    });

    it("rejects conflicting and invalid expiry options alike", async () => {
      const cases: Record<string, unknown>[] = [
        { ex: 0 },
        { ex: -1 },
        { px: 0 },
        { ex: 1.5 },
        { ex: 1, px: 1 },
        { nx: true, xx: true },
        { keepTtl: true, ex: 10 },
      ];
      for (const options of cases) {
        await same((c) => (c as Pair["real"]).set("bad", "v", options as never));
      }
    });

    it("expire with NX, XX, GT, LT matches", async () => {
      for (const mode of ["NX", "XX", "GT", "LT"] as const) {
        await pair.reset();
        await same(async (c) => {
          await c.set("e", 1);
          const first = await c.expire("e", 100, mode);
          const second = await c.expire("e", 50, mode);
          const third = await c.expire("e", 200, mode);
          return [first, second, third, bucketed(await c.ttl("e"))];
        });
      }
    });

    it("expire, pexpire, expireat, pexpireat and persist on missing keys", async () => {
      await same(async (c) => [
        await c.expire("none", 10),
        await c.pexpire("none", 10),
        await c.expireat("none", Math.floor(Date.now() / 1000) + 10),
        await c.pexpireat("none", Date.now() + 10_000),
        await c.persist("none"),
        await c.ttl("none"),
        await c.pttl("none"),
      ]);
    });

    it("keys in the past are removed immediately", async () => {
      await same(async (c) => {
        await c.set("p", 1);
        const out = [await c.expireat("p", 1), await c.exists("p"), await c.get("p")];
        await c.set("q", 1);
        out.push(await c.pexpire("q", -1), await c.exists("q"));
        return out;
      });
    });

    it("keys expire after their ttl elapses", async () => {
      await same(async (c) => {
        await c.set("s", "v", { px: 150 });
        const before = await c.get("s");
        await new Promise((resolve) => setTimeout(resolve, 400));
        return [before, await c.get("s"), await c.exists("s"), await c.ttl("s")];
      });
    });

    it("set keepTtl and overwrite semantics", async () => {
      await same(async (c) => {
        await c.set("k", 1, { ex: 100 });
        await c.set("k", 2, { keepTtl: true });
        const kept = bucketed(await c.ttl("k"));
        await c.set("k", 3);
        return [kept, await c.ttl("k"), await c.get("k")];
      });
    });

    it("setex, psetex, getex, getdel and persist interplay", async () => {
      await same(async (c) => {
        await c.setex("a", 100, "x");
        await c.psetex("b", 100_000, "y");
        const out: unknown[] = [bucketed(await c.ttl("a")), bucketed(await c.ttl("b"))];
        out.push(await c.getex("a", { persist: true }), await c.ttl("a"));
        out.push(await c.getex("b", { ex: 50 }), bucketed(await c.ttl("b")));
        out.push(await c.getdel("a"), await c.exists("a"));
        return out;
      });
    });

    it("setex rejects non-positive ttl alike", async () => {
      for (const ttl of [0, -1, 1.5]) await same((c) => c.setex("a", ttl, "x"));
    });
  });

  describe("scan", () => {
    it("full iteration returns the same key set for every count, match and type", async () => {
      for (const c of [pair.real, pair.ours]) {
        for (let i = 0; i < 25; i += 1) await c.set(`s:${i}`, i);
        await c.lpush("list", "x");
        await c.sadd("set", "x");
      }
      const drain = async (c: Client, options: Record<string, unknown>) => {
        const seen = new Set<string>();
        let cursor: string | number = 0;
        let guard = 0;
        do {
          const [next, keys] = (await c.scan(cursor, options)) as [string | number, string[]];
          for (const key of keys) seen.add(key);
          cursor = next;
          guard += 1;
        } while (String(cursor) !== "0" && guard < 200);
        return [...seen].sort();
      };
      for (const options of [{}, { count: 1 }, { count: 7 }, { match: "s:1*" }, { match: "nope*" }, { type: "list" }, { type: "set" }, { type: "string", count: 3 }]) {
        expect(await drain(pair.ours, options), JSON.stringify(options)).toEqual(await drain(pair.real, options));
      }
    });

    it("scan rejects invalid cursors alike", async () => {
      for (const cursor of ["abc", -1, "-5", "1.5"]) await same((c) => c.scan(cursor as never));
    });

    it("a finished scan returns cursor 0 and an exhausted cursor stays terminal", async () => {
      for (const c of [pair.real, pair.ours]) await c.set("only", 1);
      const result = await same((c) => c.scan(0, { count: 100 }));
      expect(result).toMatchObject({ ok: true, value: ["0", ["only"]] });
    });

    it("hscan, sscan and zscan page shapes match for small collections", async () => {
      for (const c of [pair.real, pair.ours]) {
        await c.hset("h", { a: 1, b: "two" });
        await c.sadd("s", "x", "y");
        await c.zadd("z", { score: 1, member: "m" }, { score: 2, member: "n" });
      }
      const normalize = (value: unknown) => {
        const outcome = value as { ok: boolean; value?: [unknown, unknown[]] };
        if (!outcome.ok || !outcome.value) return outcome;
        return { ...outcome, value: [outcome.value[0], [...outcome.value[1]].map(String).sort()] };
      };
      for (const run of [(c: Client) => c.hscan("h", 0), (c: Client) => c.sscan("s", 0), (c: Client) => c.zscan("z", 0)]) {
        const real = await settle(() => run(pair.real));
        const ours = await settle(() => run(pair.ours));
        expect(normalize(ours)).toEqual(normalize(real));
      }
    });
  });

  describe("random and removal commands", () => {
    it("spop, srandmember, hrandfield, zrandmember and randomkey agree on shape and exhaustion", async () => {
      for (const c of [pair.real, pair.ours]) {
        await c.sadd("s", "a", "b", "c");
        await c.hset("h", { a: 1, b: 2 });
        await c.zadd("z", { score: 1, member: "a" }, { score: 2, member: "b" });
      }
      const shape = (value: unknown): unknown => {
        if (Array.isArray(value)) return { array: value.length };
        if (value !== null && typeof value === "object") return { object: Object.keys(value).length };
        return typeof value;
      };
      const probes: [string, (c: Client) => Promise<unknown>][] = [
        ["srandmember", (c) => c.srandmember("s")],
        ["srandmember n", (c) => c.srandmember("s", 2)],
        ["srandmember -n", (c) => c.srandmember("s", -5)],
        ["srandmember missing", (c) => c.srandmember("none")],
        ["hrandfield", (c) => c.hrandfield("h")],
        ["hrandfield n", (c) => c.hrandfield("h", 2)],
        ["hrandfield n values", (c) => c.hrandfield("h", 2, true)],
        ["hrandfield missing", (c) => c.hrandfield("none")],
        ["randomkey", (c) => c.randomkey()],
        ["spop", (c) => c.spop("s")],
        ["spop n", (c) => c.spop("s", 5)],
        ["spop exhausted", (c) => c.spop("s")],
        ["spop missing n", (c) => c.spop("none", 2)],
        ["exists after spop", (c) => c.exists("s")],
      ];
      for (const [name, probe] of probes) {
        const real = await settle(() => probe(pair.real));
        const ours = await settle(() => probe(pair.ours));
        const view = (o: Outcome) => (o.ok ? { ok: true, shape: shape(o.value) } : o);
        expect(view(ours), name).toEqual(view(real));
      }
    });

    it("time returns a [seconds, microseconds] pair", async () => {
      const real = await pair.real.time();
      const ours = await pair.ours.time();
      expect(ours.map((part) => typeof part)).toEqual(real.map((part) => typeof part));
      expect(Math.abs(ours[0] - real[0])).toBeLessThanOrEqual(2);
      expect(ours[1]).toBeGreaterThanOrEqual(0);
      expect(ours[1]).toBeLessThan(1_000_000);
    });
  });
});
