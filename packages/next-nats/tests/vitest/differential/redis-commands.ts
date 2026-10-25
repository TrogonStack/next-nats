import fc from "fast-check";
import type { Call, Outcome } from "./redis-harness.js";

export const FAR_FUTURE_SECONDS = 4_102_444_800;

const key = fc.constantFrom("k1", "k2", "k3");
const field = fc.constantFrom("f1", "f2", "f3");
const member = fc.constantFrom("a", "b", "c", "d");
const int = fc.integer({ min: -5, max: 5 });
const small = fc.integer({ min: 0, max: 4 });
const bigTtl = fc.integer({ min: 1_000, max: 100_000 });

const scalar = fc.constantFrom<unknown>(
  "x", "hello world", "", "1", "42", "-7", "1.5", "007", "true", "null", '{"a":1}', "[1,2]", "abc", " 5",
  1, 2.5, -3, 0, true, false, null, { a: 1 }, [1, "b"], { n: { m: 2 } },
);
const numeric = fc.constantFrom<unknown>("1", "2", "10", "-3", "2.5", 4, 0);
const text = fc.constantFrom("x", "hello", "", "12", "z z");
const pattern = fc.constantFrom("*", "k*", "k?", "k[12]", "nope*", "k3");
const side = fc.constantFrom("left", "right");
const aggregate = fc.constantFrom("sum", "min", "max", undefined);
const score = fc.constantFrom(-2, -1, 0, 1, 1.5, 2, 3, 10);
const keyList = fc.array(key, { minLength: 1, maxLength: 3 });
const entries = (v: fc.Arbitrary<unknown>) =>
  fc.dictionary(fc.constantFrom("f1", "f2", "f3"), v, { minKeys: 1, maxKeys: 3 });
const keyedEntries = (v: fc.Arbitrary<unknown>) =>
  fc.dictionary(fc.constantFrom("k1", "k2", "k3"), v, { minKeys: 1, maxKeys: 3 });
const scoreMember = fc.record({ score, member });
const scoreMembers = fc.array(scoreMember, { minLength: 1, maxLength: 3 });
const lexBound = fc.constantFrom("-", "+", "[a", "(a", "[b", "(c", "[d");
const scoreBound = fc.constantFrom<number | string>(-1, 0, 1, 2, "-inf", "+inf", "(1", "(2", "3");
const opt = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined });
const exOption = fc.constantFrom("NX", "XX", "GT", "LT", undefined);

const setOptions = fc.oneof(
  fc.constant(undefined),
  fc.record({ nx: fc.constant(true as const) }),
  fc.record({ xx: fc.constant(true as const) }),
  fc.record({ get: fc.constant(true) }),
  fc.record({ ex: bigTtl }),
  fc.record({ px: bigTtl }),
  fc.record({ exat: fc.constant(FAR_FUTURE_SECONDS) }),
  fc.record({ pxat: fc.constant(FAR_FUTURE_SECONDS * 1000) }),
  fc.record({ keepTtl: fc.constant(true as const) }),
  fc.record({ ex: bigTtl, nx: fc.constant(true as const) }),
  fc.record({ ex: bigTtl, xx: fc.constant(true as const), get: fc.constant(true) }),
  fc.record({ keepTtl: fc.constant(true as const), nx: fc.constant(true as const) }),
);
const getexOptions = fc.oneof(
  fc.constant(undefined),
  fc.record({ ex: bigTtl }),
  fc.record({ px: bigTtl }),
  fc.record({ persist: fc.constant(true as const) }),
);
const zrangeOptions = fc.oneof(
  fc.constant(undefined),
  fc.record({ withScores: fc.constant(true) }),
  fc.record({ rev: fc.constant(true) }),
  fc.record({ rev: fc.constant(true), withScores: fc.constant(true) }),
);
const storeOptions = fc.oneof(
  fc.constant(undefined),
  fc.record({ aggregate: fc.constantFrom("sum", "min", "max") }),
  fc.record({ weights: fc.constant([2, 3, 4]) }),
  fc.record({ weight: fc.constant(2) }),
);

const call = <A extends unknown[]>(name: string, args: fc.Arbitrary<A>): fc.Arbitrary<Call> =>
  args.map((a) => ({ name, args: a.filter((v, i) => !(v === undefined && a.slice(i).every((x) => x === undefined))) }));

const none = fc.constant([] as unknown[]);

export const commandArbitraries: Record<string, fc.Arbitrary<Call>> = {
  get: call("get", fc.tuple(key)),
  set: call("set", fc.tuple(key, scalar, setOptions)),
  setnx: call("setnx", fc.tuple(key, scalar)),
  setex: call("setex", fc.tuple(key, bigTtl, scalar)),
  psetex: call("psetex", fc.tuple(key, bigTtl, scalar)),
  getset: call("getset", fc.tuple(key, scalar)),
  getdel: call("getdel", fc.tuple(key)),
  getex: call("getex", fc.tuple(key, getexOptions)),
  mget: call("mget", keyList),
  mset: call("mset", fc.tuple(keyedEntries(scalar))),
  msetnx: call("msetnx", fc.tuple(keyedEntries(scalar))),
  append: call("append", fc.tuple(key, text)),
  strlen: call("strlen", fc.tuple(key)),
  getrange: call("getrange", fc.tuple(key, int, int)),
  setrange: call("setrange", fc.tuple(key, small, text)),
  incr: call("incr", fc.tuple(key)),
  decr: call("decr", fc.tuple(key)),
  incrby: call("incrby", fc.tuple(key, int)),
  decrby: call("decrby", fc.tuple(key, int)),
  incrbyfloat: call("incrbyfloat", fc.tuple(key, fc.constantFrom(1.5, -0.5, 2, 0.25))),
  del: call("del", keyList),
  unlink: call("unlink", keyList),
  exists: call("exists", keyList),
  touch: call("touch", keyList),
  expire: call("expire", fc.tuple(key, bigTtl, exOption)),
  pexpire: call("pexpire", fc.tuple(key, bigTtl, exOption)),
  expireat: call("expireat", fc.tuple(key, fc.constant(FAR_FUTURE_SECONDS), exOption)),
  pexpireat: call("pexpireat", fc.tuple(key, fc.constant(FAR_FUTURE_SECONDS * 1000), exOption)),
  persist: call("persist", fc.tuple(key)),
  ttl: call("ttl", fc.tuple(key)),
  pttl: call("pttl", fc.tuple(key)),
  type: call("type", fc.tuple(key)),
  rename: call("rename", fc.tuple(key, key)),
  renamenx: call("renamenx", fc.tuple(key, key)),
  copy: call("copy", fc.tuple(key, key, opt(fc.record({ replace: fc.boolean() })))),
  keys: call("keys", fc.tuple(pattern)),
  scan: call("scan", fc.tuple(fc.constant("0"), fc.record({ match: pattern, count: fc.constant(100) }))),
  dbsize: call("dbsize", none),
  ping: call("ping", fc.tuple(opt(text))),
  echo: call("echo", fc.tuple(text)),
  hset: call("hset", fc.tuple(key, entries(scalar))),
  hmset: call("hmset", fc.tuple(key, entries(scalar))),
  hsetnx: call("hsetnx", fc.tuple(key, field, scalar)),
  hget: call("hget", fc.tuple(key, field)),
  hgetall: call("hgetall", fc.tuple(key)),
  hmget: call("hmget", fc.tuple(key, field, field)),
  hdel: call("hdel", fc.tuple(key, field, field)),
  hgetdel: call("hgetdel", fc.tuple(key, field, field)),
  hincrby: call("hincrby", fc.tuple(key, field, int)),
  hincrbyfloat: call("hincrbyfloat", fc.tuple(key, field, fc.constantFrom(1.5, -0.5, 2))),
  hexists: call("hexists", fc.tuple(key, field)),
  hkeys: call("hkeys", fc.tuple(key)),
  hvals: call("hvals", fc.tuple(key)),
  hlen: call("hlen", fc.tuple(key)),
  hstrlen: call("hstrlen", fc.tuple(key, field)),
  hrandfield: call("hrandfield", fc.tuple(key)),
  hscan: call("hscan", fc.tuple(key, fc.constant("0"), fc.record({ count: fc.constant(100) }))),
  lpush: call("lpush", fc.tuple(key, scalar, opt(scalar))),
  rpush: call("rpush", fc.tuple(key, scalar, opt(scalar))),
  lpushx: call("lpushx", fc.tuple(key, scalar)),
  rpushx: call("rpushx", fc.tuple(key, scalar)),
  lpop: call("lpop", fc.tuple(key, opt(small))),
  rpop: call("rpop", fc.tuple(key, opt(small))),
  llen: call("llen", fc.tuple(key)),
  lindex: call("lindex", fc.tuple(key, int)),
  lrange: call("lrange", fc.tuple(key, int, int)),
  lset: call("lset", fc.tuple(key, int, scalar)),
  lrem: call("lrem", fc.tuple(key, int, scalar)),
  ltrim: call("ltrim", fc.tuple(key, int, int)),
  linsert: call("linsert", fc.tuple(key, fc.constantFrom("before", "after"), scalar, scalar)),
  lmove: call("lmove", fc.tuple(key, key, side, side)),
  lpos: call("lpos", fc.tuple(key, scalar, opt(fc.record({ rank: fc.constantFrom(1, 2, -1) })))),
  sadd: call("sadd", fc.tuple(key, member, opt(member))),
  srem: call("srem", fc.tuple(key, member, opt(member))),
  sismember: call("sismember", fc.tuple(key, member)),
  smismember: call("smismember", fc.tuple(key, fc.array(member, { minLength: 1, maxLength: 3 }))),
  smembers: call("smembers", fc.tuple(key)),
  scard: call("scard", fc.tuple(key)),
  srandmember: call("srandmember", fc.tuple(key)),
  smove: call("smove", fc.tuple(key, key, member)),
  sdiff: call("sdiff", keyList),
  sinter: call("sinter", keyList),
  sunion: call("sunion", keyList),
  sdiffstore: call("sdiffstore", fc.tuple(key, key, opt(key))),
  sinterstore: call("sinterstore", fc.tuple(key, key, opt(key))),
  sunionstore: call("sunionstore", fc.tuple(key, key, opt(key))),
  sintercard: call("sintercard", fc.tuple(keyList, opt(fc.record({ limit: small })))),
  sscan: call("sscan", fc.tuple(key, fc.constant("0"), fc.record({ count: fc.constant(100) }))),
  zadd: fc.oneof(
    call("zadd", fc.tuple(key, scoreMember, opt(scoreMember))),
    call("zadd", fc.tuple(key, fc.constantFrom({ nx: true }, { xx: true }, { gt: true }, { lt: true }, { ch: true }, { xx: true, ch: true }), scoreMember)),
  ),
  zcard: call("zcard", fc.tuple(key)),
  zcount: call("zcount", fc.tuple(key, scoreBound, scoreBound)),
  zlexcount: call("zlexcount", fc.tuple(key, lexBound, lexBound)),
  zincrby: call("zincrby", fc.tuple(key, score, member)),
  zscore: call("zscore", fc.tuple(key, member)),
  zmscore: call("zmscore", fc.tuple(key, fc.array(member, { minLength: 1, maxLength: 3 }))),
  zrank: call("zrank", fc.tuple(key, member)),
  zrevrank: call("zrevrank", fc.tuple(key, member)),
  zrem: call("zrem", fc.tuple(key, member, opt(member))),
  zrange: fc.oneof(
    call("zrange", fc.tuple(key, int, int, zrangeOptions)),
    call("zrange", fc.tuple(key, scoreBound, scoreBound, fc.record({ byScore: fc.constant(true as const) }))),
    call("zrange", fc.tuple(key, lexBound, lexBound, fc.record({ byLex: fc.constant(true as const) }))),
  ),
  zpopmin: call("zpopmin", fc.tuple(key, opt(small))),
  zpopmax: call("zpopmax", fc.tuple(key, opt(small))),
  zremrangebyrank: call("zremrangebyrank", fc.tuple(key, int, int)),
  zremrangebyscore: call("zremrangebyscore", fc.tuple(key, scoreBound, scoreBound)),
  zremrangebylex: call("zremrangebylex", fc.tuple(key, lexBound, lexBound)),
  zunion: call("zunion", fc.tuple(fc.constant(2), fc.tuple(key, key), fc.record({ withScores: fc.constant(true) }))),
  zunionstore: call("zunionstore", fc.tuple(key, fc.constant(2), fc.tuple(key, key), storeOptions)),
  zinterstore: call("zinterstore", fc.tuple(key, fc.constant(2), fc.tuple(key, key), storeOptions)),
  zdiffstore: call("zdiffstore", fc.tuple(key, fc.constant(2), key, key)),
  zscan: call("zscan", fc.tuple(key, fc.constant("0"), fc.record({ count: fc.constant(100) }))),
  flushdb: call("flushdb", none),
};

export const commandNames = Object.keys(commandArbitraries);

export function commandArb(names: readonly string[] = commandNames): fc.Arbitrary<Call> {
  return fc.oneof(
    ...names.filter((n) => n !== "flushdb").map((n) => commandArbitraries[n] as fc.Arbitrary<Call>),
  );
}

export type PipelineCall = { name: "@pipeline"; atomic: boolean; keepErrors: boolean; commands: Call[] };

export function pipelineArb(names?: readonly string[]): fc.Arbitrary<PipelineCall> {
  return fc.record({
    name: fc.constant("@pipeline" as const),
    atomic: fc.boolean(),
    keepErrors: fc.boolean(),
    commands: fc.array(commandArb(names), { minLength: 1, maxLength: 5 }),
  });
}

const RANDOM_SHAPE = new Set(["srandmember", "hrandfield"]);
const UNORDERED = new Set(["keys", "smembers", "sdiff", "sinter", "sunion", "hkeys", "hvals"]);
const TTL = new Set(["ttl", "pttl"]);
const SCAN = new Set(["scan", "sscan"]);
const SCAN_PAIRS = new Set(["hscan", "zscan"]);

const canonical = (v: unknown) => JSON.stringify(v);
const byCanonical = (a: unknown, b: unknown) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);

const shapeOf = (v: unknown): unknown => (Array.isArray(v) ? { length: v.length } : v === null ? null : typeof v);

export function normalize(name: string, value: unknown): unknown {
  if (TTL.has(name) && typeof value === "number") return value > 0 ? "positive" : value;
  if (RANDOM_SHAPE.has(name)) return shapeOf(value);
  if (UNORDERED.has(name) && Array.isArray(value)) return [...value].sort(byCanonical);
  if (SCAN.has(name) && Array.isArray(value)) {
    const [cursor, items] = value as [unknown, unknown[]];
    return [String(cursor) === "0" ? "0" : "more", [...items].sort(byCanonical)];
  }
  if (SCAN_PAIRS.has(name) && Array.isArray(value)) {
    const [cursor, items] = value as [unknown, unknown[]];
    const pairs: unknown[][] = [];
    for (let i = 0; i < items.length; i += 2) pairs.push([items[i], items[i + 1]]);
    return [String(cursor) === "0" ? "0" : "more", pairs.sort(byCanonical)];
  }
  return value;
}

const WIRE_SUFFIX = /, command was: \[.*\]$/s;

export function stripWireSuffix(message: string): string {
  return message.replace(WIRE_SUFFIX, "");
}

const SDK_DEFECT = /^Cannot read properties of undefined \(reading '(every|0|length)'\)$/;

function carriesServerError(outcome: Outcome): boolean {
  if (!outcome.ok) return true;
  return Array.isArray(outcome.value) && outcome.value.some((entry) => (entry as { error?: unknown } | null)?.error !== undefined);
}

export function reconcileSdkDefects(_step: Call | PipelineCall, real: Outcome, ours: Outcome): Outcome {
  if (real.ok || real.name !== "TypeError" || !SDK_DEFECT.test(real.message)) return real;
  return carriesServerError(ours) ? ours : real;
}
