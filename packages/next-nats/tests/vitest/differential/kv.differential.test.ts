import { createClient as realCreateClient, kv as realKv } from "@vercel/kv";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, getNats } from "../../../src/connection.js";
import { createClient, kv } from "../../../src/kv/index.js";
import { stripWireSuffix } from "./redis-commands.js";
import { PROXY_TOKEN, PROXY_URL, requireProxy, settle as rawSettle } from "./redis-harness.js";
import type { Outcome } from "./redis-harness.js";

const available = await requireProxy();
const bucket = `kvd_${Math.random().toString(36).slice(2, 10)}`;
const SEED = Number(process.env.NEXT_NATS_PARITY_SEED ?? 20_261_025);
const PROPERTY_TIMEOUT_MS = 600_000;
const RUNS = Number(process.env.NEXT_NATS_PARITY_RUNS ?? 60);

const real = realCreateClient({ url: PROXY_URL, token: PROXY_TOKEN, retry: false });
const ours = createClient({ bucket });

async function settle(run: () => Promise<unknown>): Promise<Outcome> {
  const outcome = await rawSettle(run);
  return outcome.ok ? outcome : { ...outcome, message: stripWireSuffix(outcome.message) };
}

async function drain(iterator: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const item of iterator) items.push(item);
  return items;
}

async function both<T>(run: (client: typeof real | typeof ours) => Promise<T>): Promise<[T, T]> {
  return [await run(real), await run(ours)];
}

const keyArb = fc.constantFrom("k1", "k2", "k3", "a:1", "a:2", "b:1");
const memberArb = fc.constantFrom("m1", "m2", "m3", "m4", "m5");

describe.skipIf(!available)("@vercel/kv differential", () => {
  beforeAll(async () => {
    await connectNats({ servers: process.env.NATS_URL, name: "next-nats-kv-differential" });
  });

  afterAll(async () => {
    const { jsm } = await getNats();
    await jsm.streams.delete(`KV_${bucket}`).catch(() => undefined);
    await closeNats();
  });

  it("scanIterator yields the same keys for every match pattern and count", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(keyArb, { minLength: 0, maxLength: 6 }),
        fc.constantFrom(undefined, "*", "a:*", "k?", "zz*"),
        fc.constantFrom(undefined, 1, 2, 10),
        async (keys, match, count) => {
          await both((c) => c.flushall());
          for (const k of keys) await both((c) => c.set(k, "v"));
          const options = match === undefined && count === undefined ? undefined : { match, count };
          const [r, o] = await both(async (c) => (await drain(c.scanIterator(options))).sort());
          expect(o).toEqual(r);
        },
      ),
      { seed: SEED, numRuns: RUNS },
    );
  }, PROPERTY_TIMEOUT_MS);

  it("hscanIterator, sscanIterator and zscanIterator yield the same items", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(memberArb, { minLength: 0, maxLength: 5 }),
        fc.constantFrom(undefined, "m*", "m1", "zz*"),
        fc.constantFrom(undefined, 1, 3),
        async (members, match, count) => {
          await both((c) => c.flushall());
          for (const [i, m] of members.entries()) {
            await both((c) => c.hset("h", { [m]: i }));
            await both((c) => c.sadd("s", m));
            await both((c) => c.zadd("z", { score: i, member: m }));
          }
          const options = { match, count };
          for (const iterate of ["hscanIterator", "sscanIterator", "zscanIterator"] as const) {
            const [r, o] = await both(async (c) => {
              const key = iterate[0] === "h" ? "h" : iterate[0] === "s" ? "s" : "z";
              const items = await drain(c[iterate](key, options));
              return items.map(String).sort();
            });
            expect(o, iterate).toEqual(r);
          }
        },
      ),
      { seed: SEED + 1, numRuns: RUNS },
    );
  }, PROPERTY_TIMEOUT_MS);

  it("scan iterators on a missing key or wrong type behave alike", async () => {
    await both((c) => c.flushall());
    await both((c) => c.set("str", "x"));
    for (const iterate of ["hscanIterator", "sscanIterator", "zscanIterator"] as const) {
      for (const key of ["missing", "str"]) {
        const [r, o] = await both((c) => settle(() => drain(c[iterate](key))));
        expect(o, `${iterate} ${key}`).toEqual(r);
      }
    }
  });

  it("createClient defaults match: errors carry the auto-pipelining prefix", async () => {
    await both((c) => c.flushall());
    await both((c) => c.lpush("l", "x"));
    const [r, o] = await both((c) => settle(() => c.incr("l")));
    expect(o).toEqual(r);
    const [rd, od] = await both((c) => settle(() => c.hgetall("l")));
    expect(od).toEqual(rd);
  });

  it("createClient lets explicit config override the defaults", async () => {
    const plain = realCreateClient({ url: PROXY_URL, token: PROXY_TOKEN, retry: false, enableAutoPipelining: false });
    const plainOurs = createClient({ bucket, enableAutoPipelining: false });
    await both((c) => c.flushall());
    await both((c) => c.lpush("l", "x"));
    const r = await settle(() => plain.incr("l"));
    const o = await settle(() => plainOurs.incr("l"));
    expect(o).toEqual(r);
  });

  it("generated command sequences through the client agree", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant("set" as const), key: keyArb, value: fc.integer({ min: -3, max: 3 }) }),
            fc.record({ op: fc.constant("get" as const), key: keyArb }),
            fc.record({ op: fc.constant("incr" as const), key: keyArb }),
            fc.record({ op: fc.constant("del" as const), key: keyArb }),
            fc.record({ op: fc.constant("lpush" as const), key: keyArb, value: memberArb }),
            fc.record({ op: fc.constant("lrange" as const), key: keyArb }),
          ),
          { minLength: 1, maxLength: 12 },
        ),
        async (steps) => {
          await both((c) => c.flushall());
          for (const step of steps) {
            const run = (c: typeof real | typeof ours) =>
              settle(() => {
                switch (step.op) {
                  case "set":
                    return c.set(step.key, step.value);
                  case "get":
                    return c.get(step.key);
                  case "incr":
                    return c.incr(step.key);
                  case "del":
                    return c.del(step.key);
                  case "lpush":
                    return c.lpush(step.key, step.value);
                  case "lrange":
                    return c.lrange(step.key, 0, -1);
                }
              });
            const [r, o] = await both(run);
            expect(o, JSON.stringify(step)).toEqual(r);
          }
        },
      ),
      { seed: SEED + 2, numRuns: RUNS },
    );
  }, PROPERTY_TIMEOUT_MS);

  it("the kv singleton round trips values the same way when configured through the environment", async () => {
    process.env.KV_REST_API_URL = PROXY_URL;
    process.env.KV_REST_API_TOKEN = PROXY_TOKEN;
    await realKv.set("env:key", { a: 1 });
    await kv.set("env:key", { a: 1 });
    expect(await kv.get("env:key")).toEqual(await realKv.get("env:key"));
    await realKv.del("env:key");
    await kv.del("env:key");
  });
});
