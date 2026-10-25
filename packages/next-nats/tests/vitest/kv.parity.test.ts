import { createClient as upstreamCreateClient, kv as upstreamKv, VercelKV as UpstreamVercelKV } from "@vercel/kv";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import defaultExport, { createClient, kv, VercelKV } from "../../src/kv/index.js";
import { Redis } from "../../src/redis/index.js";

const run = Math.random().toString(36).slice(2, 8);
const BUCKET = `kvp_${run}`;

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_SERVERS, name: "next-nats-kv-parity-test" });
});

afterAll(async () => {
  const { jsm } = await getNats();
  await jsm.streams.delete(`KV_${BUCKET}`).catch(() => undefined);
  await closeNats();
});

describe("type parity with @vercel/kv", () => {
  it("exports the same names", () => {
    expect(typeof createClient).toBe("function");
    expect(typeof upstreamCreateClient).toBe("function");
    expect(kv).toBeInstanceOf(VercelKV);
    expect(kv).toBeInstanceOf(Redis);
    expect(defaultExport).toBe(kv);
    expect(upstreamKv).toBeDefined();
  });

  it("matches the iterator signatures", () => {
    type Ours = VercelKV;
    type Theirs = UpstreamVercelKV;
    expectTypeOf<Ours["scanIterator"]>().parameters.toEqualTypeOf<Parameters<Theirs["scanIterator"]>>();
    expectTypeOf<Ours["hscanIterator"]>().parameters.toEqualTypeOf<Parameters<Theirs["hscanIterator"]>>();
    expectTypeOf<Ours["sscanIterator"]>().parameters.toEqualTypeOf<Parameters<Theirs["sscanIterator"]>>();
    expectTypeOf<Ours["zscanIterator"]>().parameters.toEqualTypeOf<Parameters<Theirs["zscanIterator"]>>();
  });
});

describe("behavior", () => {
  it("iterates scan, hscan, sscan, zscan", async () => {
    const client = createClient({ bucket: BUCKET });
    await client.mset({ "it:1": "a", "it:2": "b", "it:3": "c" });
    const keys: string[] = [];
    for await (const k of client.scanIterator({ match: "it:*", count: 2 })) keys.push(k);
    expect(keys.sort()).toEqual(["it:1", "it:2", "it:3"]);

    await client.hset("it:h", { a: "1", b: "2" });
    const fields: unknown[] = [];
    for await (const f of client.hscanIterator("it:h")) fields.push(f);
    expect(fields.length).toBe(4);

    await client.sadd("it:s", "x", "y");
    const members: unknown[] = [];
    for await (const m of client.sscanIterator("it:s")) members.push(m);
    expect(members.length).toBe(2);

    await client.zadd("it:z", { score: 1, member: "m" });
    const scored: unknown[] = [];
    for await (const m of client.zscanIterator("it:z")) scored.push(m);
    expect(scored).toEqual(["m", 1]);
  });
});
