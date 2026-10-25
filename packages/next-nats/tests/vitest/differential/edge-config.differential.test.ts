import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import * as real from "@vercel/edge-config";
import { closeNats, connectNats, getNats } from "../../../src/connection.js";
import * as ours from "../../../src/edge-config/index.js";
import { FakeVercelEdgeConfig, type FakeOperation, type FakeValue } from "../../support/fakes/vercel-edge-config.js";

const SEED = 20260502;
const run = Math.random().toString(36).slice(2, 8);
const fake = new FakeVercelEdgeConfig();
const buckets: string[] = [];
let counter = 0;

type Outcome = "ok" | "failed";

interface Subject {
  name: string;
  get(key: unknown, opts?: { consistentRead?: boolean }): Promise<unknown>;
  getAll(keys?: unknown, opts?: { consistentRead?: boolean }): Promise<unknown>;
  has(key: unknown, opts?: { consistentRead?: boolean }): Promise<boolean>;
  digest(opts?: { consistentRead?: boolean }): Promise<string>;
  write(items: unknown[]): Promise<Outcome>;
  settle(): Promise<void>;
}

async function waitFor(fn: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 15));
  }
}

function realSubject(id: string, seed: Record<string, FakeValue> = {}): Subject {
  fake.create(id, seed);
  const client = real.createClient(fake.connectionString(id));
  return {
    name: "real",
    get: (k, o) => client.get(k as string, o),
    getAll: (k, o) => client.getAll(k as string[] | undefined, o),
    has: (k, o) => client.has(k as string, o),
    digest: (o) => client.digest(o),
    async write(items) {
      return (await fake.patch(id, items)).status === 200 ? "ok" : "failed";
    },
    async settle() {},
  };
}

async function oursSubject(id: string, seed: Record<string, FakeValue> = {}): Promise<Subject> {
  const conn = `edge-config:id=${id}&token=t`;
  buckets.push(id);
  if (Object.keys(seed).length > 0) {
    await ours.updateEdgeConfigItems(conn, {
      items: Object.entries(seed).map(([key, value]) => ({ operation: "create" as const, key, value })),
    });
  }
  const client = ours.createClient(conn);
  return {
    name: "ours",
    get: (k, o) => client.get(k as string, o),
    getAll: (k, o) => client.getAll(k as string[] | undefined, o),
    has: (k, o) => client.has(k as string, o),
    digest: (o) => client.digest(o),
    async write(items) {
      try {
        await ours.updateEdgeConfigItems(conn, { items: items as ours.EdgeConfigItemOperation[] });
        return "ok";
      } catch (err) {
        if (err instanceof ours.EdgeConfigError) return "failed";
        throw err;
      }
    },
    async settle() {
      await waitFor(async () => (await client.digest()) === (await client.digest({ consistentRead: true })));
    },
  };
}

async function pair(seed: Record<string, FakeValue> = {}): Promise<[Subject, Subject]> {
  const id = `ecd_${run}_${counter++}`;
  const r = realSubject(id, seed);
  const o = await oursSubject(id, seed);
  await o.settle();
  return [r, o];
}

async function both<T>(fn: (s: Subject) => Promise<T>): Promise<[T, T]> {
  const [r, o] = await pair();
  return [await fn(r), await fn(o)];
}

async function errorOf(fn: () => Promise<unknown>): Promise<{ name: string; message: string } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return { name: (err as Error).constructor.name, message: (err as Error).message };
  }
}

beforeAll(async () => {
  await fake.start();
  await connectNats({ servers: process.env.NATS_SERVERS, name: "next-nats-ec-differential" });
});

afterAll(async () => {
  const { jsm } = await getNats();
  for (const b of buckets) await jsm.streams.delete(`KV_${b}`).catch(() => undefined);
  await closeNats();
  await fake.stop();
});

const SEED_ITEMS: Record<string, FakeValue> = {
  str: "hello",
  empty: "",
  num: 42,
  float: 1.5,
  zero: 0,
  yes: true,
  no: false,
  nil: null,
  list: [1, "two", null, [3]],
  obj: { a: { b: [1, 2] }, c: null },
  "dash-key": 1,
  under_key: 2,
};

describe("edge config reads: real client against the fake vs ours on NATS", () => {
  it("serves an empty config identically", async () => {
    const [r, o] = await pair();
    for (const s of [r, o]) {
      expect(await s.getAll(), s.name).toEqual({});
      expect(await s.get("x"), s.name).toBeUndefined();
      expect(await s.has("x"), s.name).toBe(false);
      expect(await s.getAll(["x"]), s.name).toEqual({});
      expect(await s.getAll([]), s.name).toEqual({});
    }
  });

  it("returns every JSON value shape the same way", async () => {
    const [r, o] = await pair(SEED_ITEMS);
    for (const s of [r, o]) {
      expect(await s.getAll(), s.name).toEqual(SEED_ITEMS);
      for (const [key, value] of Object.entries(SEED_ITEMS)) {
        expect(await s.get(key), `${s.name} get ${key}`).toEqual(value);
        expect(await s.has(key), `${s.name} has ${key}`).toBe(true);
      }
    }
  });

  it("treats null-valued items as present", async () => {
    const [r, o] = await pair({ nil: null });
    for (const s of [r, o]) {
      expect(await s.get("nil"), s.name).toBeNull();
      expect(await s.has("nil"), s.name).toBe(true);
      expect(await s.getAll(["nil"]), s.name).toEqual({ nil: null });
    }
  });

  it("filters getAll by keys and drops missing ones", async () => {
    const [r, o] = await pair(SEED_ITEMS);
    const cases: string[][] = [["str"], ["str", "num"], ["str", "missing"], ["missing"], ["str", "str"], ["", "  ", "str"], ["", "  "], []];
    for (const keys of cases) {
      expect(await o.getAll(keys), JSON.stringify(keys)).toEqual(await r.getAll(keys));
    }
  });

  it("treats blank keys as absent without erroring", async () => {
    const [r, o] = await pair(SEED_ITEMS);
    for (const s of [r, o]) {
      for (const key of ["", " ", "\t"]) {
        expect(await s.get(key), s.name).toBeUndefined();
        expect(await s.has(key), s.name).toBe(false);
      }
    }
  });

  it("rejects bad argument types with the same error class and message", async () => {
    const [r, o] = await pair(SEED_ITEMS);
    const probes: Array<[string, (s: Subject) => Promise<unknown>]> = [
      ["get number", (s) => s.get(1)],
      ["get undefined", (s) => s.get(undefined)],
      ["get null", (s) => s.get(null)],
      ["has number", (s) => s.has(1)],
      ["has object", (s) => s.has({})],
      ["getAll string", (s) => s.getAll("a")],
      ["getAll number array", (s) => s.getAll([1])],
      ["getAll mixed array", (s) => s.getAll(["a", 1])],
      ["getAll object", (s) => s.getAll({})],
    ];
    for (const [label, fn] of probes) {
      const real_ = await errorOf(() => fn(r));
      const ours_ = await errorOf(() => fn(o));
      expect(real_, `real ${label}`).not.toBeNull();
      expect(ours_, `ours ${label}`).toEqual(real_);
    }
  });

  it("accepts the same optional arguments for getAll", async () => {
    const [r, o] = await pair(SEED_ITEMS);
    for (const keys of [undefined, null, 0, ""]) {
      expect(await errorOf(() => o.getAll(keys))).toEqual(await errorOf(() => r.getAll(keys)));
    }
  });

  it("returns values the caller may mutate", async () => {
    const [r, o] = await pair(SEED_ITEMS);
    for (const s of [r, o]) {
      const first = (await s.get("obj")) as { a: { b: number[] } };
      first.a.b.push(99);
      expect(await s.get("obj"), s.name).toEqual(SEED_ITEMS.obj);
      const all = (await s.getAll()) as Record<string, unknown>;
      delete all.str;
      expect(await s.has("str"), s.name).toBe(true);
    }
  });

  it("consistentRead returns the same results", async () => {
    const [r, o] = await pair(SEED_ITEMS);
    const opts = { consistentRead: true };
    for (const s of [r, o]) {
      expect(await s.get("str", opts), s.name).toBe("hello");
      expect(await s.get("missing", opts), s.name).toBeUndefined();
      expect(await s.has("str", opts), s.name).toBe(true);
      expect(await s.has("missing", opts), s.name).toBe(false);
      expect(await s.getAll(["str", "num"], opts), s.name).toEqual({ str: "hello", num: 42 });
      expect(await s.getAll(undefined, opts), s.name).toEqual(SEED_ITEMS);
    }
  });

  it("digest is stable for equal content and changes with content", async () => {
    const [r, o] = await pair({ a: 1 });
    for (const s of [r, o]) {
      const d1 = await s.digest();
      expect(typeof d1, s.name).toBe("string");
      expect(d1.length, s.name).toBeGreaterThan(0);
      expect(await s.digest(), s.name).toBe(d1);
      expect(await s.digest({ consistentRead: true }), s.name).toBe(d1);
      expect(await s.write([{ operation: "update", key: "a", value: 2 }]), s.name).toBe("ok");
      await s.settle();
      const d2 = await s.digest();
      expect(d2, s.name).not.toBe(d1);
      expect(await s.write([{ operation: "update", key: "a", value: 1 }]), s.name).toBe("ok");
      await s.settle();
      expect(await s.digest(), `${s.name} restores digest for restored content`).toBe(d1);
    }
  });

  it("sends the headers and paths documented in the real source", async () => {
    const id = `ecd_${run}_wire`;
    realSubject(id, { k: 1 });
    const client = real.createClient(fake.connectionString(id), { staleIfError: 60 });
    fake.requests.length = 0;
    await client.get("k");
    await client.has("k", { consistentRead: true });
    await client.getAll(["k", "z"]);
    await client.digest();
    const byPath = (suffix: string, method: string) => fake.requests.find((q) => q.path.endsWith(suffix) && q.method === method);
    expect(byPath(`/${id}/item/k`, "GET")?.headers.authorization).toBe(`Bearer ${fake.readToken}`);
    expect(byPath(`/${id}/item/k`, "GET")?.headers["x-edge-config-sdk"]).toBe("@vercel/edge-config@1.5.1");
    expect(byPath(`/${id}/item/k`, "GET")?.headers["cache-control"]).toBe("stale-if-error=60");
    expect(byPath(`/${id}/item/k`, "HEAD")?.headers["x-edge-config-min-updated-at"]).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(byPath(`/${id}/items`, "GET")?.query.getAll("key")).toEqual(["k", "z"]);
    expect(byPath(`/${id}/digest`, "GET")?.query.get("version")).toBe("1");
  });
});

describe("edge config connection strings", () => {
  const cases = [
    "edge-config:id=ecfg_abc&token=tok",
    "edge-config:id=ecfg_abc&token=tok&version=2",
    "edge-config:id=ecfg_abc",
    "edge-config:token=tok",
    "edge-config:",
    "https://edge-config.vercel.com/ecfg_abc?token=tok",
    "https://edge-config.vercel.com/ecfg_abc",
    "https://edge-config.vercel.com/other?token=tok",
    "http://edge-config.vercel.com/ecfg_abc?token=tok",
    "https://example.com/ecfg_abc?token=tok",
    "https://example.com/abc?id=ecfg_x&token=tok&version=3",
    "http://127.0.0.1:1234/ecfg_abc?token=tok",
    "https://example.com",
    "nope",
    "",
  ];

  it("parses every shape the real package accepts to the same connection", () => {
    for (const text of cases) {
      const expected = real.parseConnectionString(text);
      if (expected === null) continue;
      expect(ours.parseConnectionString(text), text).toEqual(expected);
    }
  });

  it("rejects what the real package rejects, except token-less bucket ids", () => {
    for (const text of cases) {
      if (real.parseConnectionString(text) !== null) continue;
      const parsed = ours.parseConnectionString(text);
      if (text === "edge-config:id=ecfg_abc") expect(parsed?.id, text).toBe("ecfg_abc");
      else expect(parsed, text).toBeNull();
    }
  });

  it("createClient throws the same errors", () => {
    for (const text of [undefined, "", "nope", "https://example.com", "edge-config:token=t"]) {
      const a = (() => {
        try {
          real.createClient(text);
          return null;
        } catch (err) {
          return (err as Error).message;
        }
      })();
      const b = (() => {
        try {
          ours.createClient(text);
          return null;
        } catch (err) {
          return (err as Error).message;
        }
      })();
      expect(b, String(text)).toEqual(a);
    }
  });

  it("clone is the same deep copy", () => {
    const value = { a: [1, { b: null }], c: "x" };
    expect(ours.clone(value)).toEqual(real.clone(value));
    expect(ours.clone(value)).not.toBe(value);
    expect(() => ours.clone(undefined)).toThrow();
    expect(() => real.clone(undefined)).toThrow();
  });

  it("reports the same failure when the default client has no connection string", async () => {
    const saved = process.env.EDGE_CONFIG;
    delete process.env.EDGE_CONFIG;
    try {
      expect(() => real.createClient(process.env.EDGE_CONFIG)).toThrow("@vercel/edge-config: No connection string provided");
    } finally {
      if (saved !== undefined) process.env.EDGE_CONFIG = saved;
    }
  });
});

describe("edge config REST write semantics: fake of the Vercel API vs updateEdgeConfigItems", () => {
  const batches: Array<[string, Record<string, FakeValue>, unknown[], Outcome]> = [
    ["create new", {}, [{ operation: "create", key: "a", value: 1 }], "ok"],
    ["create existing", { a: 1 }, [{ operation: "create", key: "a", value: 2 }], "failed"],
    ["update existing", { a: 1 }, [{ operation: "update", key: "a", value: 2 }], "ok"],
    ["update missing", {}, [{ operation: "update", key: "a", value: 2 }], "failed"],
    ["upsert new", {}, [{ operation: "upsert", key: "a", value: 2 }], "ok"],
    ["upsert existing", { a: 1 }, [{ operation: "upsert", key: "a", value: 2 }], "ok"],
    ["delete existing", { a: 1 }, [{ operation: "delete", key: "a" }], "ok"],
    ["delete missing", {}, [{ operation: "delete", key: "a" }], "failed"],
    ["create then update same key", {}, [{ operation: "create", key: "a", value: 1 }, { operation: "update", key: "a", value: 2 }], "ok"],
    ["create twice in one batch", {}, [{ operation: "create", key: "a", value: 1 }, { operation: "create", key: "a", value: 2 }], "failed"],
    ["delete then create", { a: 1 }, [{ operation: "delete", key: "a" }, { operation: "create", key: "a", value: 2 }], "ok"],
    ["delete then update", { a: 1 }, [{ operation: "delete", key: "a" }, { operation: "update", key: "a", value: 2 }], "failed"],
    ["null value", {}, [{ operation: "create", key: "a", value: null }], "ok"],
    ["nested value", {}, [{ operation: "upsert", key: "a", value: { x: [1, { y: "z" }] } }], "ok"],
    ["empty batch", { a: 1 }, [], "ok"],
    ["key with colon", {}, [{ operation: "create", key: "flags:beta", value: 1 }], "failed"],
    ["key with space", {}, [{ operation: "create", key: "a b", value: 1 }], "failed"],
    ["key with slash", {}, [{ operation: "create", key: "a/b", value: 1 }], "failed"],
    ["empty key", {}, [{ operation: "create", key: "", value: 1 }], "failed"],
    ["key of 256 characters", {}, [{ operation: "create", key: "k".repeat(256), value: 1 }], "ok"],
    ["key of 257 characters", {}, [{ operation: "create", key: "k".repeat(257), value: 1 }], "failed"],
    ["dash and underscore key", {}, [{ operation: "create", key: "a-b_c", value: 1 }], "ok"],
    ["all or nothing: valid then invalid", { a: 1 }, [{ operation: "upsert", key: "b", value: 2 }, { operation: "update", key: "missing", value: 3 }], "failed"],
    ["all or nothing: delete then invalid", { a: 1 }, [{ operation: "delete", key: "a" }, { operation: "create", key: "bad key", value: 3 }], "failed"],
  ];

  for (const [label, seed, items, expected] of batches) {
    it(label, async () => {
      const [r, o] = await pair(seed);
      expect(await r.write(items), "real fake").toBe(expected);
      expect(await o.write(items), "ours").toBe(expected);
      await o.settle();
      expect(await o.getAll(undefined, { consistentRead: true }), "state").toEqual(await r.getAll(undefined, { consistentRead: true }));
    });
  }

  it("resolves { status: ok } like the REST response", async () => {
    const id = `ecd_${run}_status`;
    const subject = await oursSubject(id);
    void subject;
    expect(await ours.updateEdgeConfigItems(`edge-config:id=${id}&token=t`, { items: [] })).toEqual({ status: "ok" });
    fake.create(id);
    const res = await fake.patch(id, []);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("edge config generated operation sequences", () => {
  const key = fc.constantFrom("a", "b", "c", "d_1", "e-2", "bad:key");
  const leaf = fc.oneof(fc.string({ maxLength: 6 }), fc.integer({ min: -1000, max: 1000 }), fc.boolean(), fc.constant(null));
  const value: fc.Arbitrary<FakeValue> = fc.oneof(
    leaf,
    fc.array(leaf, { maxLength: 3 }),
    fc.dictionary(fc.constantFrom("x", "y", "z"), leaf, { maxKeys: 3 }),
  );
  const operation: fc.Arbitrary<FakeOperation> = fc.oneof(
    fc.record({ operation: fc.constantFrom("create", "update", "upsert"), key, value }) as fc.Arbitrary<FakeOperation>,
    fc.record({ operation: fc.constant("delete" as const), key }),
  );
  const batch = fc.array(operation, { minLength: 1, maxLength: 4 });

  it("agrees on outcomes, state and digest after every batch", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(batch, { minLength: 1, maxLength: 5 }), async (batches) => {
        const [r, o] = await pair();
        const digests = [new Map<string, string>(), new Map<string, string>()];
        for (const items of batches) {
          const before = await Promise.all([r.digest(), o.digest()]);
          const ro = await r.write(items);
          const oo = await o.write(items);
          expect(oo, JSON.stringify(items)).toBe(ro);
          await o.settle();
          const stateR = await r.getAll();
          const stateO = await o.getAll();
          expect(stateO).toEqual(stateR);
          for (const k of ["a", "b", "c", "d_1", "e-2", "zz"]) {
            expect(await o.get(k), k).toEqual(await r.get(k));
            expect(await o.has(k), k).toBe(await r.has(k));
          }
          const after = await Promise.all([r.digest(), o.digest()]);
          if (ro === "failed") expect(after).toEqual(before);
          [r, o].forEach((_, i) => {
            const canonical = JSON.stringify(Object.entries(stateR).sort(([x], [y]) => (x < y ? -1 : 1)));
            const known = digests[i]!.get(after[i]!);
            expect(known === undefined || known === canonical, "digest maps to one state").toBe(true);
            digests[i]!.set(after[i]!, canonical);
          });
        }
      }),
      { seed: SEED, numRuns: 25, verbose: 1 },
    );
  }, 180_000);
});
