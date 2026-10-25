import "server-only";
import { globToRegExp, encodeKey } from "../kv/key.js";
import { KvStore, UpstashError } from "../kv/store.js";
import type { Store } from "../kv/store.js";
import { Transaction } from "../kv/transaction.js";
import type { KvRecord, RecordKind } from "../kv/store.js";
import {
  asFloat,
  asInteger,
  checkKind,
  deserialize,
  inLexRange,
  inScoreRange,
  isEmptyValue,
  normalizeKeys,
  parseLexBound,
  parseScoreBound,
  range,
  serialize,
  sliceRange,
  sortZ,
  syntaxError,
  wrongType,
} from "./codec.js";
import type { ZEntry } from "./codec.js";
import { UnsupportedCommandError } from "./errors.js";
import { createPipeline } from "./pipeline.js";
import type { Pipeline } from "./pipeline.js";
import type {
  ExpireOption,
  GetExCommandOptions,
  RedisConfigNodejs,
  ScanCommandOptions,
  ScanResultStandard,
  ScanResultWithType,
  ScoreMember,
  SetCommandOptions,
  Type,
  ZAddCommandOptions,
  ZInterStoreCommandOptions,
  ZRangeCommandOptions,
  ZUnionCommandOptions,
  ZUnionStoreCommandOptions,
} from "./types.js";

export const internals: unique symbol = Symbol.for("@trogonstack/next-nats/redis.internals");

export interface RedisInternals {
  readonly store: Store;
  readonly auto: boolean;
  readonly transaction?: true;
}

const KIND_OF_TYPE: Record<string, RecordKind> = { string: "s", hash: "h", list: "l", set: "S", zset: "z" };
const TYPE_OF_KIND: Record<RecordKind, Type> = { s: "string", h: "hash", l: "list", S: "set", z: "zset" };

type Mutation<V, R> = { next?: V | null; result: R };

function withExpiry(rec: KvRecord, x: number | undefined): KvRecord {
  const { x: _drop, ...rest } = rec;
  return x === undefined ? rest : { ...rest, x };
}

function expiryFrom(opts: SetCommandOptions, current: KvRecord | null, now: number): number | undefined {
  if (opts.ex !== undefined) return now + opts.ex * 1000;
  if (opts.px !== undefined) return now + opts.px;
  if (opts.exat !== undefined) return opts.exat * 1000;
  if (opts.pxat !== undefined) return opts.pxat;
  if (opts.keepTtl) return current?.x;
  return undefined;
}

function pairsOf(record: Record<string, string>): Array<[string, string]> {
  return Object.entries(record);
}

function randomPick<T>(items: readonly T[], count: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length > 0) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0] as T);
  }
  return out;
}

function toMap(entries: ZEntry[]): Map<string, number> {
  return new Map(entries);
}

export class Redis {
  readonly [internals]: RedisInternals;

  constructor(config: RedisConfigNodejs = {}) {
    const bucket = config.bucket ?? process.env.NEXT_NATS_KV_BUCKET ?? "kv";
    this[internals] = { store: new KvStore({ bucket }), auto: config.automaticDeserialization ?? true };
  }

  static fromEnv(config?: Omit<RedisConfigNodejs, "url" | "token">): Redis {
    return new this({ ...config });
  }

  private get store(): Store {
    return this[internals].store;
  }

  private get auto(): boolean {
    return this[internals].auto;
  }

  private de<T = unknown>(raw: string | null | undefined): T | null {
    return deserialize<T>(raw, this.auto);
  }

  private async load<V>(key: string, kind: RecordKind): Promise<V | null> {
    return checkKind<V>((await this.store.read(key)).rec, kind);
  }

  private update<V, R>(key: string, kind: RecordKind, fn: (current: V | null) => Mutation<V, R>): Promise<R> {
    return this.store.mutate<R>(key, (rec) => {
      const { next, result } = fn(checkKind<V>(rec, kind));
      if (next === undefined) return { next: undefined, result };
      if (next === null || isEmptyValue(next)) return { next: rec ? null : undefined, result };
      return { next: rec ? { ...rec, v: next } : { t: kind, v: next }, result };
    });
  }

  private async transact<R>(fn: (redis: Redis) => Promise<R>): Promise<R> {
    const { store, auto, transaction } = this[internals];
    if (transaction || !(await store.atomic)) return fn(this);
    for (let attempt = 0; attempt < store.maxRetries; attempt++) {
      const tx = new Transaction(store as KvStore);
      const scoped: Redis = Object.create(this);
      Object.defineProperty(scoped, internals, { value: { store: tx, auto, transaction: true } });
      const result = await fn(scoped);
      if (await tx.flush()) return result;
      if (attempt > 2) await new Promise((r) => setTimeout(r, Math.random() * Math.min(5 * attempt, 50)));
    }
    throw new UpstashError("ERR", "transaction contention exceeded the retry limit");
  }

  pipeline(): Pipeline {
    return createPipeline(this, false);
  }

  multi(): Pipeline {
    return createPipeline(this, true);
  }

  async ping(message?: string): Promise<string> {
    return message ?? "PONG";
  }

  async echo(message: string): Promise<string> {
    return message;
  }

  async time(): Promise<[number, number]> {
    const ms = Date.now();
    return [Math.floor(ms / 1000), (ms % 1000) * 1000];
  }

  async eval<TArgs extends unknown[], TData = unknown>(..._args: [script: string, keys: string[], args: TArgs]): Promise<TData> {
    throw new UnsupportedCommandError("eval");
  }

  async evalRo<TArgs extends unknown[], TData = unknown>(..._args: [script: string, keys: string[], args: TArgs]): Promise<TData> {
    throw new UnsupportedCommandError("evalRo");
  }

  async evalsha<TArgs extends unknown[], TData = unknown>(..._args: [sha1: string, keys: string[], args: TArgs]): Promise<TData> {
    throw new UnsupportedCommandError("evalsha");
  }

  async evalshaRo<TArgs extends unknown[], TData = unknown>(..._args: [sha1: string, keys: string[], args: TArgs]): Promise<TData> {
    throw new UnsupportedCommandError("evalshaRo");
  }

  async scriptLoad(_script: string): Promise<string> {
    throw new UnsupportedCommandError("scriptLoad");
  }

  async scriptExists(..._sha1: string[]): Promise<number[]> {
    throw new UnsupportedCommandError("scriptExists");
  }

  async scriptFlush(_opts?: { sync?: boolean; async?: boolean }): Promise<"OK"> {
    throw new UnsupportedCommandError("scriptFlush");
  }

  createScript(_script: string, _opts?: { readonly?: boolean }): never {
    throw new UnsupportedCommandError("createScript");
  }

  async get<TData>(key: string): Promise<TData | null> {
    return this.de<TData>(await this.load<string>(key, "s"));
  }

  async set<TData>(key: string, value: TData, opts: SetCommandOptions = {} as SetCommandOptions): Promise<"OK" | TData | null> {
    const raw = serialize(value);
    const simple = !opts.nx && !opts.xx && !opts.keepTtl && !opts.get;
    if (simple) {
      const x = expiryFrom(opts, null, Date.now());
      if (x !== undefined && x <= Date.now()) {
        await this.del(key);
        return "OK";
      }
      await this.store.write(key, withExpiry({ t: "s", v: raw }, x), undefined);
      return "OK";
    }
    return this.store.mutate<"OK" | TData | null>(key, (cur) => {
      if (opts.get && cur && cur.t !== "s") throw wrongType();
      const previous = cur ? this.de<TData>(cur.v as string) : null;
      const blocked = (opts.nx && cur) || (opts.xx && !cur);
      if (blocked) return { next: undefined, result: opts.get ? previous : null };
      const x = expiryFrom(opts, cur, Date.now());
      if (x !== undefined && x <= Date.now()) return { next: null, result: opts.get ? previous : "OK" };
      return { next: withExpiry({ t: "s", v: raw }, x), result: opts.get ? previous : "OK" };
    });
  }

  async setnx<TData>(key: string, value: TData): Promise<number> {
    return (await this.set(key, value, { nx: true })) === "OK" ? 1 : 0;
  }

  async setex<TData>(key: string, ttl: number, value: TData): Promise<"OK"> {
    await this.set(key, value, { ex: ttl });
    return "OK";
  }

  async psetex<TData>(key: string, ttl: number, value: TData): Promise<string> {
    await this.set(key, value, { px: ttl });
    return "OK";
  }

  async getset<TData>(key: string, value: TData): Promise<TData | null> {
    return (await this.set(key, value, { get: true })) as TData | null;
  }

  async getdel<TData>(key: string): Promise<TData | null> {
    return this.store.mutate<TData | null>(key, (cur) => {
      if (!cur) return { next: undefined, result: null };
      if (cur.t !== "s") throw wrongType();
      return { next: null, result: this.de<TData>(cur.v as string) };
    });
  }

  async getex<TData>(key: string, opts?: GetExCommandOptions): Promise<TData | null> {
    return this.store.mutate<TData | null>(key, (cur) => {
      if (!cur) return { next: undefined, result: null };
      if (cur.t !== "s") throw wrongType();
      const result = this.de<TData>(cur.v as string);
      const now = Date.now();
      let x: number | undefined | "keep" = "keep";
      if (opts?.ex !== undefined) x = now + opts.ex * 1000;
      else if (opts?.px !== undefined) x = now + opts.px;
      else if (opts?.exat !== undefined) x = opts.exat * 1000;
      else if (opts?.pxat !== undefined) x = opts.pxat;
      else if (opts?.persist) x = undefined;
      if (x === "keep") return { next: undefined, result };
      if (x !== undefined && x <= now) return { next: null, result };
      return { next: withExpiry(cur, x), result };
    });
  }

  async mget<TData extends unknown[]>(...keys: [string[]] | string[]): Promise<TData> {
    return (await Promise.all(normalizeKeys(keys).map((k) => this.get(k)))) as TData;
  }

  async mset<TData>(kv: Record<string, TData>): Promise<"OK"> {
    await Promise.all(Object.entries(kv).map(([k, v]) => this.set(k, v)));
    return "OK";
  }

  async msetnx<TData>(kv: Record<string, TData>): Promise<number> {
    const keys = Object.keys(kv);
    if ((await this.exists(...keys)) > 0) return 0;
    await this.mset(kv);
    return 1;
  }

  async append(key: string, value: string): Promise<number> {
    return this.update<string, number>(key, "s", (cur) => {
      const next = (cur ?? "") + value;
      return { next, result: Buffer.byteLength(next) };
    });
  }

  async strlen(key: string): Promise<number> {
    return Buffer.byteLength((await this.load<string>(key, "s")) ?? "");
  }

  async getrange(key: string, start: number, end: number): Promise<string> {
    const bytes = Buffer.from((await this.load<string>(key, "s")) ?? "");
    const r = range(start, end, bytes.length);
    return r ? bytes.subarray(r[0], r[1] + 1).toString() : "";
  }

  async setrange(key: string, offset: number, value: string): Promise<number> {
    if (offset < 0) throw new UpstashError("ERR", "offset is out of range");
    return this.update<string, number>(key, "s", (cur) => {
      const bytes = Buffer.from(cur ?? "");
      const patch = Buffer.from(value);
      if (patch.length === 0) return { result: bytes.length };
      const out = Buffer.alloc(Math.max(bytes.length, offset + patch.length));
      bytes.copy(out);
      patch.copy(out, offset);
      return { next: out.toString(), result: out.length };
    });
  }

  incrby(key: string, value: number): Promise<number> {
    return this.update<string, number>(key, "s", (cur) => {
      const next = (cur === null ? 0 : asInteger(cur)) + value;
      if (!Number.isSafeInteger(next)) throw new UpstashError("ERR", "increment or decrement would overflow");
      return { next: String(next), result: next };
    });
  }

  incr(key: string): Promise<number> {
    return this.incrby(key, 1);
  }

  decr(key: string): Promise<number> {
    return this.incrby(key, -1);
  }

  decrby(key: string, decrement: number): Promise<number> {
    return this.incrby(key, -decrement);
  }

  incrbyfloat(key: string, value: number): Promise<number> {
    return this.update<string, number>(key, "s", (cur) => {
      const next = (cur === null ? 0 : asFloat(cur)) + value;
      if (!Number.isFinite(next)) throw new UpstashError("ERR", "increment would produce NaN or Infinity");
      return { next: String(next), result: next };
    });
  }

  async del(...keys: [string[]] | string[]): Promise<number> {
    const counts = await Promise.all(
      normalizeKeys(keys).map((k) =>
        this.store.mutate(k, (cur) => (cur ? { next: null, result: 1 } : { next: undefined, result: 0 })),
      ),
    );
    return counts.reduce<number>((a, b) => a + b, 0);
  }

  unlink(...keys: [string[]] | string[]): Promise<number> {
    return this.del(...keys);
  }

  async exists(...keys: [string[]] | string[]): Promise<number> {
    const found = await Promise.all(normalizeKeys(keys).map(async (k) => (await this.store.read(k)).rec !== null));
    return found.filter(Boolean).length;
  }

  touch(...keys: [string[]] | string[]): Promise<number> {
    return this.exists(...keys);
  }

  private setExpiry(key: string, at: number, option?: ExpireOption): Promise<0 | 1> {
    const mode = option?.toUpperCase();
    return this.store.mutate<0 | 1>(key, (cur) => {
      if (!cur) return { next: undefined, result: 0 };
      if (mode === "NX" && cur.x !== undefined) return { next: undefined, result: 0 };
      if (mode === "XX" && cur.x === undefined) return { next: undefined, result: 0 };
      if (mode === "GT" && (cur.x === undefined || at <= cur.x)) return { next: undefined, result: 0 };
      if (mode === "LT" && cur.x !== undefined && at >= cur.x) return { next: undefined, result: 0 };
      if (at <= Date.now()) return { next: null, result: 1 };
      return { next: { ...cur, x: at }, result: 1 };
    });
  }

  expire(key: string, seconds: number, option?: ExpireOption): Promise<0 | 1> {
    return this.setExpiry(key, Date.now() + seconds * 1000, option);
  }

  pexpire(key: string, milliseconds: number, option?: ExpireOption): Promise<0 | 1> {
    return this.setExpiry(key, Date.now() + milliseconds, option);
  }

  expireat(key: string, unix: number, option?: ExpireOption): Promise<0 | 1> {
    return this.setExpiry(key, unix * 1000, option);
  }

  pexpireat(key: string, unix: number, option?: ExpireOption): Promise<0 | 1> {
    return this.setExpiry(key, unix, option);
  }

  persist(key: string): Promise<0 | 1> {
    return this.store.mutate<0 | 1>(key, (cur) =>
      cur && cur.x !== undefined ? { next: withExpiry(cur, undefined), result: 1 } : { next: undefined, result: 0 },
    );
  }

  async pttl(key: string): Promise<number> {
    const { rec } = await this.store.read(key);
    if (!rec) return -2;
    return rec.x === undefined ? -1 : Math.max(0, rec.x - Date.now());
  }

  async ttl(key: string): Promise<number> {
    const ms = await this.pttl(key);
    return ms < 0 ? ms : Math.ceil(ms / 1000);
  }

  async type(key: string): Promise<Type> {
    const { rec } = await this.store.read(key);
    return rec ? TYPE_OF_KIND[rec.t] : "none";
  }

  async rename(source: string, destination: string): Promise<"OK"> {
    const moved = await this.store.mutate<KvRecord | null>(source, (cur) => ({ next: cur ? null : undefined, result: cur }));
    if (!moved) throw new UpstashError("ERR", "no such key");
    await this.store.write(destination, moved, undefined);
    return "OK";
  }

  async renamenx(source: string, destination: string): Promise<0 | 1> {
    if (!(await this.store.read(source)).rec) throw new UpstashError("ERR", "no such key");
    if ((await this.store.read(destination)).rec) return 0;
    await this.rename(source, destination);
    return 1;
  }

  async copy(key: string, destinationKey: string, opts?: { replace: boolean }): Promise<"COPIED" | "NOT_COPIED"> {
    const { rec } = await this.store.read(key);
    if (!rec) return "NOT_COPIED";
    if (!opts?.replace && (await this.store.read(destinationKey)).rec) return "NOT_COPIED";
    await this.store.write(destinationKey, rec, undefined);
    return "COPIED";
  }

  async keys(pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern);
    const candidates = (await this.store.allKeys()).filter((k) => re.test(k));
    const live = await Promise.all(candidates.map(async (k) => ((await this.store.read(k)).rec ? k : null)));
    return live.filter((k): k is string => k !== null);
  }

  scan(cursor: string | number): Promise<ScanResultStandard>;
  scan<TOptions extends ScanCommandOptions>(
    cursor: string | number,
    opts: TOptions,
  ): Promise<TOptions extends { withType: true } ? ScanResultWithType : ScanResultStandard>;
  async scan(cursor: string | number, opts: ScanCommandOptions = {}): Promise<ScanResultStandard | ScanResultWithType> {
    const start = Number(cursor);
    if (!Number.isInteger(start) || start < 0) throw new UpstashError("ERR", "invalid cursor");
    const count = opts.count ?? 10;
    const all = await this.store.allKeys();
    const slice = all.slice(start, start + count);
    const next = start + count >= all.length ? "0" : String(start + count);
    const re = opts.match ? globToRegExp(opts.match) : null;
    const wanted = "type" in opts && opts.type ? KIND_OF_TYPE[opts.type] ?? null : null;
    const filterType = "type" in opts && opts.type !== undefined;
    const picked = await Promise.all(
      slice.map(async (k) => {
        if (re && !re.test(k)) return null;
        const { rec } = await this.store.read(k);
        if (!rec) return null;
        if (filterType && rec.t !== wanted) return null;
        return { key: k, type: TYPE_OF_KIND[rec.t] as string };
      }),
    );
    const live = picked.filter((p): p is { key: string; type: string } => p !== null);
    return opts.withType ? [next, live] : [next, live.map((p) => p.key)];
  }

  async randomkey(): Promise<string | null> {
    const all = await this.keys("*");
    return all.length === 0 ? null : (all[Math.floor(Math.random() * all.length)] as string);
  }

  async dbsize(): Promise<number> {
    return (await this.keys("*")).length;
  }

  async flushdb(_opts?: { async?: boolean }): Promise<"OK"> {
    const kv = await this.store.kv();
    for (const k of await this.store.allKeys()) await kv.purge(encodeKey(k));
    return "OK";
  }

  flushall(args?: [{ async?: boolean }]): Promise<"OK"> {
    return this.flushdb(args?.[0]);
  }

  async hset<TData>(key: string, kv: Record<string, TData>): Promise<number> {
    const entries = pairsOf(Object.fromEntries(Object.entries(kv).map(([f, v]) => [f, serialize(v)])));
    if (entries.length === 0) throw new UpstashError("ERR", "wrong number of arguments for 'hset' command");
    return this.update<Record<string, string>, number>(key, "h", (cur) => {
      const existing = cur ?? {};
      const added = entries.filter(([f]) => !(f in existing)).length;
      return { next: { ...existing, ...Object.fromEntries(entries) }, result: added };
    });
  }

  async hmset<TData>(key: string, kv: Record<string, TData>): Promise<"OK"> {
    await this.hset(key, kv);
    return "OK";
  }

  async hsetnx<TData>(key: string, field: string, value: TData): Promise<0 | 1> {
    const raw = serialize(value);
    return this.update<Record<string, string>, 0 | 1>(key, "h", (cur) => {
      const existing = cur ?? {};
      if (field in existing) return { result: 0 };
      return { next: { ...existing, [field]: raw }, result: 1 };
    });
  }

  async hget<TData>(key: string, field: string): Promise<TData | null> {
    const h = await this.load<Record<string, string>>(key, "h");
    return h && field in h ? this.de<TData>(h[field]) : null;
  }

  async hgetall<TData extends Record<string, unknown>>(key: string): Promise<TData | null> {
    const h = await this.load<Record<string, string>>(key, "h");
    if (!h || Object.keys(h).length === 0) return null;
    return Object.fromEntries(Object.entries(h).map(([f, v]) => [f, this.de(v)])) as TData;
  }

  async hmget<TData extends Record<string, unknown>>(key: string, ...fields: string[]): Promise<TData | null> {
    const h = await this.load<Record<string, string>>(key, "h");
    if (!h || fields.every((f) => !(f in h))) return null;
    return Object.fromEntries(fields.map((f) => [f, f in h ? this.de(h[f]) : null])) as TData;
  }

  async hgetdel<TData extends Record<string, unknown>>(key: string, ...fields: (string | number)[]): Promise<TData | null> {
    const names = fields.map(String);
    const taken = await this.update<Record<string, string>, Record<string, string> | null>(key, "h", (cur) => {
      if (!cur) return { result: null };
      const hit = names.filter((f) => f in cur);
      if (hit.length === 0) return { result: null };
      const rest = Object.fromEntries(Object.entries(cur).filter(([f]) => !names.includes(f)));
      return { next: rest, result: Object.fromEntries(names.map((f) => [f, cur[f] as string])) };
    });
    if (!taken) return null;
    return Object.fromEntries(Object.entries(taken).map(([f, v]) => [f, this.de(v)])) as TData;
  }

  async hdel(key: string, ...fields: string[]): Promise<0 | 1> {
    return this.update<Record<string, string>, number>(key, "h", (cur) => {
      if (!cur) return { result: 0 };
      const removed = fields.filter((f) => f in cur);
      if (removed.length === 0) return { result: 0 };
      return { next: Object.fromEntries(Object.entries(cur).filter(([f]) => !fields.includes(f))), result: removed.length };
    }) as Promise<0 | 1>;
  }

  hincrby(key: string, field: string, increment: number): Promise<number> {
    return this.update<Record<string, string>, number>(key, "h", (cur) => {
      const existing = cur ?? {};
      const next = (field in existing ? asInteger(existing[field]) : 0) + increment;
      if (!Number.isSafeInteger(next)) throw new UpstashError("ERR", "increment or decrement would overflow");
      return { next: { ...existing, [field]: String(next) }, result: next };
    });
  }

  hincrbyfloat(key: string, field: string, increment: number): Promise<number> {
    return this.update<Record<string, string>, number>(key, "h", (cur) => {
      const existing = cur ?? {};
      const next = (field in existing ? asFloat(existing[field]) : 0) + increment;
      if (!Number.isFinite(next)) throw new UpstashError("ERR", "increment would produce NaN or Infinity");
      return { next: { ...existing, [field]: String(next) }, result: next };
    });
  }

  async hexists(key: string, field: string): Promise<number> {
    const h = await this.load<Record<string, string>>(key, "h");
    return h && field in h ? 1 : 0;
  }

  async hkeys(key: string): Promise<string[]> {
    return Object.keys((await this.load<Record<string, string>>(key, "h")) ?? {});
  }

  async hvals(key: string): Promise<any> {
    return Object.values((await this.load<Record<string, string>>(key, "h")) ?? {}).map((v) => this.de(v));
  }

  async hlen(key: string): Promise<number> {
    return Object.keys((await this.load<Record<string, string>>(key, "h")) ?? {}).length;
  }

  async hstrlen(key: string, field: string): Promise<number> {
    const h = await this.load<Record<string, string>>(key, "h");
    return h && field in h ? Buffer.byteLength(h[field] as string) : 0;
  }

  hrandfield(key: string): Promise<string | null>;
  hrandfield(key: string, count: number): Promise<string[]>;
  hrandfield<TData extends Record<string, unknown>>(key: string, count: number, withValues: boolean): Promise<Partial<TData>>;
  async hrandfield(key: string, count?: number, withValues?: boolean): Promise<unknown> {
    const h = (await this.load<Record<string, string>>(key, "h")) ?? {};
    const fields = Object.keys(h);
    if (count === undefined) return fields.length === 0 ? null : (randomPick(fields, 1)[0] as string);
    const picked =
      count >= 0
        ? randomPick(fields, count)
        : fields.length === 0
          ? []
          : Array.from({ length: -count }, () => fields[Math.floor(Math.random() * fields.length)] as string);
    if (!withValues) return picked;
    return Object.fromEntries(picked.map((f) => [f, this.de(h[f])]));
  }

  private scanSlice<T>(items: T[], cursor: string | number, opts?: ScanCommandOptions): [T[], string] {
    const start = Number(cursor);
    if (!Number.isInteger(start) || start < 0) throw new UpstashError("ERR", "invalid cursor");
    const count = opts?.count ?? 10;
    return [items.slice(start, start + count), start + count >= items.length ? "0" : String(start + count)];
  }

  async hscan(key: string, cursor: string | number, opts?: ScanCommandOptions): Promise<[string, (string | number)[]]> {
    const h = (await this.load<Record<string, string>>(key, "h")) ?? {};
    const re = opts?.match ? globToRegExp(opts.match) : null;
    const [slice, next] = this.scanSlice(Object.entries(h), cursor, opts);
    const flat = slice.filter(([f]) => !re || re.test(f)).flatMap(([f, v]) => [f, this.de<string | number>(v) as string | number]);
    return [next, flat];
  }

  async lpush<TData>(key: string, ...elements: TData[]): Promise<number> {
    const items = elements.map(serialize).reverse();
    return this.update<string[], number>(key, "l", (cur) => {
      const next = [...items, ...(cur ?? [])];
      return { next, result: next.length };
    });
  }

  async rpush<TData>(key: string, ...elements: TData[]): Promise<number> {
    const items = elements.map(serialize);
    return this.update<string[], number>(key, "l", (cur) => {
      const next = [...(cur ?? []), ...items];
      return { next, result: next.length };
    });
  }

  async lpushx<TData>(key: string, ...elements: TData[]): Promise<number> {
    const items = elements.map(serialize).reverse();
    return this.update<string[], number>(key, "l", (cur) =>
      cur ? { next: [...items, ...cur], result: items.length + cur.length } : { result: 0 },
    );
  }

  async rpushx<TData>(key: string, ...elements: TData[]): Promise<number> {
    const items = elements.map(serialize);
    return this.update<string[], number>(key, "l", (cur) =>
      cur ? { next: [...cur, ...items], result: items.length + cur.length } : { result: 0 },
    );
  }

  private pop<TData>(key: string, count: number | undefined, side: "left" | "right"): Promise<TData | null> {
    return this.update<string[], unknown>(key, "l", (cur) => {
      if (!cur) return { result: null };
      const n = count ?? 1;
      const taken = side === "left" ? cur.slice(0, n) : cur.slice(Math.max(0, cur.length - n)).reverse();
      const rest = side === "left" ? cur.slice(n) : cur.slice(0, Math.max(0, cur.length - n));
      const decoded = taken.map((v) => this.de(v));
      return { next: rest, result: count === undefined ? (decoded[0] ?? null) : decoded };
    }) as Promise<TData | null>;
  }

  lpop<TData = string>(key: string, count?: number): Promise<TData | null> {
    return this.pop<TData>(key, count, "left");
  }

  rpop<TData = string>(key: string, count?: number): Promise<TData | null> {
    return this.pop<TData>(key, count, "right");
  }

  async llen(key: string): Promise<number> {
    return ((await this.load<string[]>(key, "l")) ?? []).length;
  }

  async lindex(key: string, index: number): Promise<any> {
    const list = (await this.load<string[]>(key, "l")) ?? [];
    return this.de(list.at(index));
  }

  async lrange<TResult = string>(key: string, start: number, end: number): Promise<TResult[]> {
    const list = (await this.load<string[]>(key, "l")) ?? [];
    return sliceRange(list, start, end).map((v) => this.de<TResult>(v) as TResult);
  }

  async lset<TData>(key: string, index: number, value: TData): Promise<"OK"> {
    const raw = serialize(value);
    await this.update<string[], null>(key, "l", (cur) => {
      if (!cur) throw new UpstashError("ERR", "no such key");
      const at = index < 0 ? cur.length + index : index;
      if (at < 0 || at >= cur.length) throw new UpstashError("ERR", "index out of range");
      const next = [...cur];
      next[at] = raw;
      return { next, result: null };
    });
    return "OK";
  }

  async lrem<TData>(key: string, count: number, value: TData): Promise<number> {
    const raw = serialize(value);
    return this.update<string[], number>(key, "l", (cur) => {
      if (!cur) return { result: 0 };
      const limit = count === 0 ? Number.POSITIVE_INFINITY : Math.abs(count);
      const order = count < 0 ? [...cur.keys()].reverse() : [...cur.keys()];
      const drop = new Set<number>();
      for (const i of order) {
        if (drop.size >= limit) break;
        if (cur[i] === raw) drop.add(i);
      }
      return { next: cur.filter((_, i) => !drop.has(i)), result: drop.size };
    });
  }

  async ltrim(key: string, start: number, end: number): Promise<"OK"> {
    await this.update<string[], null>(key, "l", (cur) => (cur ? { next: sliceRange(cur, start, end), result: null } : { result: null }));
    return "OK";
  }

  async linsert<TData>(key: string, direction: "before" | "after", pivot: TData, value: TData): Promise<number> {
    const pivotRaw = serialize(pivot);
    const raw = serialize(value);
    return this.update<string[], number>(key, "l", (cur) => {
      if (!cur) return { result: 0 };
      const at = cur.indexOf(pivotRaw);
      if (at === -1) return { result: -1 };
      const next = [...cur];
      next.splice(direction === "before" ? at : at + 1, 0, raw);
      return { next, result: next.length };
    });
  }

  async lmove<TData = string>(
    source: string,
    destination: string,
    whereFrom: "left" | "right",
    whereTo: "left" | "right",
  ): Promise<TData> {
    const moved = await this.pop<string>(source, undefined, whereFrom);
    if (moved === null) return null as TData;
    const raw = serialize(moved);
    await this.update<string[], null>(destination, "l", (cur) => ({
      next: whereTo === "left" ? [raw, ...(cur ?? [])] : [...(cur ?? []), raw],
      result: null,
    }));
    return this.de<TData>(raw) as TData;
  }

  async lpos<TData = number>(key: string, element: unknown, opts?: { rank?: number; count?: number; maxLen?: number }): Promise<TData> {
    const raw = serialize(element);
    const list = (await this.load<string[]>(key, "l")) ?? [];
    const rank = opts?.rank ?? 1;
    if (rank === 0) throw new UpstashError("ERR", "RANK can't be zero");
    const scanned = opts?.maxLen ? (rank > 0 ? list.slice(0, opts.maxLen) : list.slice(-opts.maxLen)) : list;
    const offset = opts?.maxLen && rank < 0 ? list.length - scanned.length : 0;
    const hits: number[] = [];
    scanned.forEach((v, i) => {
      if (v === raw) hits.push(i + offset);
    });
    const ordered = rank > 0 ? hits.slice(rank - 1) : hits.reverse().slice(-rank - 1);
    if (opts?.count === undefined) return (ordered[0] ?? null) as TData;
    return (opts.count === 0 ? ordered : ordered.slice(0, opts.count)) as TData;
  }

  async sadd<TData>(key: string, member: TData, ...members: TData[]): Promise<number> {
    const items = [member, ...members].map(serialize);
    return this.update<string[], number>(key, "S", (cur) => {
      const set = new Set(cur ?? []);
      const before = set.size;
      for (const m of items) set.add(m);
      return { next: [...set], result: set.size - before };
    });
  }

  async srem<TData>(key: string, ...members: TData[]): Promise<number> {
    const items = new Set(members.map(serialize));
    return this.update<string[], number>(key, "S", (cur) => {
      if (!cur) return { result: 0 };
      const rest = cur.filter((m) => !items.has(m));
      return { next: rest, result: cur.length - rest.length };
    });
  }

  async sismember<TData>(key: string, member: TData): Promise<0 | 1> {
    return ((await this.load<string[]>(key, "S")) ?? []).includes(serialize(member)) ? 1 : 0;
  }

  async smismember<TMembers extends unknown[]>(key: string, members: TMembers): Promise<(0 | 1)[]> {
    const set = new Set((await this.load<string[]>(key, "S")) ?? []);
    return members.map((m) => (set.has(serialize(m)) ? 1 : 0));
  }

  async smembers<TData extends unknown[] = string[]>(key: string): Promise<TData> {
    return ((await this.load<string[]>(key, "S")) ?? []).map((m) => this.de(m)) as TData;
  }

  async scard(key: string): Promise<number> {
    return ((await this.load<string[]>(key, "S")) ?? []).length;
  }

  async spop<TData>(key: string, count?: number): Promise<TData | null> {
    return this.update<string[], unknown>(key, "S", (cur) => {
      if (!cur) return { result: null };
      const taken = randomPick(cur, count ?? 1);
      const rest = cur.filter((m) => !taken.includes(m));
      const decoded = taken.map((m) => this.de(m));
      return { next: rest, result: count === undefined ? (decoded[0] ?? null) : decoded };
    }) as Promise<TData | null>;
  }

  async srandmember<TData>(key: string, count?: number): Promise<TData | null> {
    const set = await this.load<string[]>(key, "S");
    if (!set) return null;
    if (count === undefined) return this.de<TData>(randomPick(set, 1)[0]);
    const picked =
      count >= 0 ? randomPick(set, count) : Array.from({ length: -count }, () => set[Math.floor(Math.random() * set.length)] as string);
    return picked.map((m) => this.de(m)) as TData;
  }

  async smove<TData>(source: string, destination: string, member: TData): Promise<0 | 1> {
    const raw = serialize(member);
    const removed = await this.update<string[], number>(source, "S", (cur) =>
      cur && cur.includes(raw) ? { next: cur.filter((m) => m !== raw), result: 1 } : { result: 0 },
    );
    if (!removed) return 0;
    await this.update<string[], null>(destination, "S", (cur) => ({ next: [...new Set([...(cur ?? []), raw])], result: null }));
    return 1;
  }

  private async sets(keys: string[]): Promise<string[][]> {
    return Promise.all(keys.map(async (k) => (await this.load<string[]>(k, "S")) ?? []));
  }

  private async diff(keys: string[]): Promise<string[]> {
    const [first = [], ...others] = await this.sets(keys);
    const exclude = new Set(others.flat());
    return first.filter((m) => !exclude.has(m));
  }

  private async inter(keys: string[]): Promise<string[]> {
    const [first = [], ...others] = await this.sets(keys);
    const sets = others.map((s) => new Set(s));
    return first.filter((m) => sets.every((s) => s.has(m)));
  }

  private async union(keys: string[]): Promise<string[]> {
    return [...new Set((await this.sets(keys)).flat())];
  }

  private async storeSet(destination: string, members: string[]): Promise<number> {
    await this.store.mutate(destination, (cur) => {
      if (members.length === 0) return { next: cur ? null : undefined, result: null };
      return { next: { t: "S", v: members }, result: null };
    });
    return members.length;
  }

  async sdiff(key: string, ...keys: string[]): Promise<unknown[]> {
    return (await this.diff([key, ...keys])).map((m) => this.de(m));
  }

  async sinter(key: string, ...keys: string[]): Promise<string[]> {
    return (await this.inter([key, ...keys])).map((m) => this.de(m) as string);
  }

  async sunion(key: string, ...keys: string[]): Promise<unknown[]> {
    return (await this.union([key, ...keys])).map((m) => this.de(m));
  }

  async sdiffstore(destination: string, ...keys: string[]): Promise<number> {
    return this.storeSet(destination, await this.diff(keys));
  }

  async sinterstore(destination: string, key: string, ...keys: string[]): Promise<number> {
    return this.storeSet(destination, await this.inter([key, ...keys]));
  }

  async sunionstore(destination: string, key: string, ...keys: string[]): Promise<number> {
    return this.storeSet(destination, await this.union([key, ...keys]));
  }

  async sintercard(keys: string[], opts?: { limit?: number }): Promise<number> {
    const size = (await this.inter(keys)).length;
    return opts?.limit ? Math.min(size, opts.limit) : size;
  }

  async sscan(key: string, cursor: string | number, opts?: ScanCommandOptions): Promise<[string, (string | number)[]]> {
    const set = (await this.load<string[]>(key, "S")) ?? [];
    const re = opts?.match ? globToRegExp(opts.match) : null;
    const [slice, next] = this.scanSlice(set, cursor, opts);
    return [next, slice.filter((m) => !re || re.test(m)).map((m) => this.de<string | number>(m) as string | number)];
  }

  private updateZ<R>(key: string, fn: (cur: ZEntry[] | null) => Mutation<ZEntry[], R>): Promise<R> {
    return this.update<ZEntry[], R>(key, "z", (cur) => {
      const out = fn(cur);
      return out.next === undefined || out.next === null ? out : { ...out, next: sortZ([...out.next]) };
    });
  }

  private async zload(key: string): Promise<ZEntry[]> {
    const rec = (await this.store.read(key)).rec;
    if (rec && rec.t === "S") return (rec.v as string[]).map((m): ZEntry => [m, 1]);
    return checkKind<ZEntry[]>(rec, "z") ?? [];
  }

  private flatten(entries: ZEntry[], withScores: boolean): unknown[] {
    return withScores ? entries.flatMap(([m, s]) => [this.de(m), s]) : entries.map(([m]) => this.de(m));
  }

  async zadd<TData>(
    ...args:
      | [key: string, scoreMember: ScoreMember<TData>, ...scoreMemberPairs: ScoreMember<TData>[]]
      | [key: string, opts: ZAddCommandOptions, ...scoreMemberPairs: [ScoreMember<TData>, ...ScoreMember<TData>[]]]
  ): Promise<number | null> {
    const [key, second, ...rest] = args as [string, ScoreMember<TData> | ZAddCommandOptions, ...ScoreMember<TData>[]];
    const hasOpts = !("score" in second && "member" in second);
    const opts = hasOpts ? (second as ZAddCommandOptions) : ({} as ZAddCommandOptions);
    const pairs = (hasOpts ? rest : [second as ScoreMember<TData>, ...rest]).map((p) => ({
      member: serialize(p.member),
      score: p.score,
    }));
    if (pairs.length === 0) throw syntaxError();
    if (opts.incr && pairs.length !== 1) throw new UpstashError("ERR", "INCR option supports a single increment-element pair");
    return this.updateZ<number | null>(key, (cur) => {
      const map = toMap(cur ?? []);
      let added = 0;
      let changed = 0;
      let incremented: number | null = null;
      for (const { member, score } of pairs) {
        const old = map.get(member);
        if (opts.nx && old !== undefined) continue;
        if (opts.xx && old === undefined) continue;
        const target = opts.incr ? (old ?? 0) + score : score;
        if (old !== undefined && opts.gt && target <= old) continue;
        if (old !== undefined && opts.lt && target >= old) continue;
        if (old === undefined) added++;
        else if (old !== target) changed++;
        map.set(member, target);
        incremented = target;
      }
      const result = opts.incr ? incremented : opts.ch ? added + changed : added;
      return { next: [...map.entries()], result };
    });
  }

  async zcard(key: string): Promise<number> {
    return (await this.zload(key)).length;
  }

  async zcount(key: string, min: number | string, max: number | string): Promise<number> {
    const lo = parseScoreBound(min);
    const hi = parseScoreBound(max);
    return (await this.zload(key)).filter(([, s]) => inScoreRange(s, lo, hi)).length;
  }

  async zlexcount(key: string, min: string, max: string): Promise<number> {
    const lo = parseLexBound(min);
    const hi = parseLexBound(max);
    return (await this.zload(key)).filter(([m]) => inLexRange(m, lo, hi)).length;
  }

  async zincrby<TData>(key: string, increment: number, member: TData): Promise<number> {
    const raw = serialize(member);
    return this.updateZ<number>(key, (cur) => {
      const map = toMap(cur ?? []);
      const next = (map.get(raw) ?? 0) + increment;
      map.set(raw, next);
      return { next: [...map.entries()], result: next };
    });
  }

  async zscore<TData>(key: string, member: TData): Promise<number | null> {
    return toMap(await this.zload(key)).get(serialize(member)) ?? null;
  }

  async zmscore<TData>(key: string, members: TData[]): Promise<number[] | null> {
    const entries = await this.zload(key);
    if (entries.length === 0) return null;
    const map = toMap(entries);
    return members.map((m) => map.get(serialize(m)) ?? null) as number[];
  }

  async zrank<TData>(key: string, member: TData): Promise<number | null> {
    const at = (await this.zload(key)).findIndex(([m]) => m === serialize(member));
    return at === -1 ? null : at;
  }

  async zrevrank<TData>(key: string, member: TData): Promise<number | null> {
    const entries = await this.zload(key);
    const at = entries.findIndex(([m]) => m === serialize(member));
    return at === -1 ? null : entries.length - 1 - at;
  }

  async zrem<TData>(key: string, ...members: TData[]): Promise<number> {
    const drop = new Set(members.map(serialize));
    return this.updateZ<number>(key, (cur) => {
      if (!cur) return { result: 0 };
      const rest = cur.filter(([m]) => !drop.has(m));
      return { next: rest, result: cur.length - rest.length };
    });
  }

  zrange<TData extends unknown[]>(
    ...args:
      | [key: string, min: number, max: number, opts?: ZRangeCommandOptions]
      | [
          key: string,
          min: `(${string}` | `[${string}` | "-" | "+",
          max: `(${string}` | `[${string}` | "-" | "+",
          opts: { byLex: true } & ZRangeCommandOptions,
        ]
      | [
          key: string,
          min: number | `(${number}` | "-inf" | "+inf",
          max: number | `(${number}` | "-inf" | "+inf",
          opts: { byScore: true } & ZRangeCommandOptions,
        ]
  ): Promise<TData> {
    const [key, min, max, opts] = args as [string, number | string, number | string, ZRangeCommandOptions | undefined];
    return this.zrangeImpl(key, min, max, opts ?? {}) as Promise<TData>;
  }

  private async zrangeImpl(key: string, min: number | string, max: number | string, opts: ZRangeCommandOptions): Promise<unknown[]> {
    const entries = await this.zload(key);
    const ordered = opts.rev ? [...entries].reverse() : entries;
    let picked: ZEntry[];
    if (opts.byScore) {
      const [lo, hi] = opts.rev ? [max, min] : [min, max];
      const bounds: [ReturnType<typeof parseScoreBound>, ReturnType<typeof parseScoreBound>] = [parseScoreBound(lo), parseScoreBound(hi)];
      picked = ordered.filter(([, s]) => inScoreRange(s, bounds[0], bounds[1]));
    } else if (opts.byLex) {
      const [lo, hi] = opts.rev ? [max, min] : [min, max];
      const bounds = [parseLexBound(String(lo)), parseLexBound(String(hi))] as const;
      picked = ordered.filter(([m]) => inLexRange(m, bounds[0], bounds[1]));
    } else {
      picked = sliceRange(ordered, Number(min), Number(max));
    }
    if (opts.offset !== undefined && opts.count !== undefined) {
      picked = opts.count < 0 ? picked.slice(opts.offset) : picked.slice(opts.offset, opts.offset + opts.count);
    }
    return this.flatten(picked, opts.withScores === true);
  }

  private zpop<TData>(key: string, count: number | undefined, side: "min" | "max"): Promise<TData[]> {
    return this.updateZ<unknown[]>(key, (cur) => {
      if (!cur) return { result: [] };
      const n = count ?? 1;
      const taken = side === "min" ? cur.slice(0, n) : cur.slice(Math.max(0, cur.length - n)).reverse();
      const rest = side === "min" ? cur.slice(n) : cur.slice(0, Math.max(0, cur.length - n));
      return { next: rest, result: this.flatten(taken, true) };
    }) as Promise<TData[]>;
  }

  zpopmin<TData>(key: string, count?: number): Promise<TData[]> {
    return this.zpop<TData>(key, count, "min");
  }

  zpopmax<TData>(key: string, count?: number): Promise<TData[]> {
    return this.zpop<TData>(key, count, "max");
  }

  async zremrangebyrank(key: string, start: number, stop: number): Promise<number> {
    return this.updateZ<number>(key, (cur) => {
      if (!cur) return { result: 0 };
      const r = range(start, stop, cur.length);
      if (!r) return { result: 0 };
      return { next: [...cur.slice(0, r[0]), ...cur.slice(r[1] + 1)], result: r[1] - r[0] + 1 };
    });
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    const lo = parseScoreBound(min);
    const hi = parseScoreBound(max);
    return this.updateZ<number>(key, (cur) => {
      if (!cur) return { result: 0 };
      const rest = cur.filter(([, s]) => !inScoreRange(s, lo, hi));
      return { next: rest, result: cur.length - rest.length };
    });
  }

  async zremrangebylex(key: string, min: string, max: string): Promise<number> {
    const lo = parseLexBound(min);
    const hi = parseLexBound(max);
    return this.updateZ<number>(key, (cur) => {
      if (!cur) return { result: 0 };
      const rest = cur.filter(([m]) => !inLexRange(m, lo, hi));
      return { next: rest, result: cur.length - rest.length };
    });
  }

  private async combine(
    mode: "union" | "inter",
    keys: string[],
    opts: { aggregate?: "sum" | "min" | "max"; weight?: number; weights?: number[] },
  ): Promise<ZEntry[]> {
    const weights = opts.weights ?? keys.map(() => opts.weight ?? 1);
    const sources = await Promise.all(keys.map((k) => this.zload(k)));
    const aggregate = opts.aggregate ?? "sum";
    const totals = new Map<string, number>();
    const seen = new Map<string, number>();
    sources.forEach((entries, i) => {
      for (const [m, s] of entries) {
        const weighted = s * (weights[i] ?? 1);
        const prior = totals.get(m);
        seen.set(m, (seen.get(m) ?? 0) + 1);
        if (prior === undefined) totals.set(m, weighted);
        else totals.set(m, aggregate === "sum" ? prior + weighted : aggregate === "min" ? Math.min(prior, weighted) : Math.max(prior, weighted));
      }
    });
    const result = [...totals.entries()].filter(([m]) => mode === "union" || seen.get(m) === keys.length);
    return sortZ(result);
  }

  private async storeZ(destination: string, entries: ZEntry[]): Promise<number> {
    await this.store.mutate(destination, (cur) => {
      if (entries.length === 0) return { next: cur ? null : undefined, result: null };
      return { next: { t: "z", v: entries }, result: null };
    });
    return entries.length;
  }

  zunion<TData extends unknown[]>(
    ...args: [numKeys: 1, key: string, opts?: ZUnionCommandOptions] | [numKeys: number, keys: string[], opts?: ZUnionCommandOptions]
  ): Promise<any> {
    const [, keys, opts] = args;
    return this.combine("union", ([] as string[]).concat(keys), opts ?? {}).then(
      (entries) => this.flatten(entries, opts?.withScores === true) as TData,
    );
  }

  async zunionstore(
    ...args:
      | [destination: string, numKeys: 1, key: string, opts?: ZUnionStoreCommandOptions]
      | [destination: string, numKeys: number, keys: string[], opts?: ZUnionStoreCommandOptions]
  ): Promise<number> {
    const [destination, , keys, opts] = args;
    return this.storeZ(destination, await this.combine("union", ([] as string[]).concat(keys), opts ?? {}));
  }

  async zinterstore(
    ...args:
      | [destination: string, numKeys: 1, key: string, opts?: ZInterStoreCommandOptions]
      | [destination: string, numKeys: number, keys: string[], opts?: ZInterStoreCommandOptions]
  ): Promise<number> {
    const [destination, , keys, opts] = args;
    return this.storeZ(destination, await this.combine("inter", ([] as string[]).concat(keys), opts ?? {}));
  }

  async zdiffstore(destination: string, numkeys: number, ...keys: string[]): Promise<number> {
    const [first = [], ...others] = await Promise.all(keys.slice(0, numkeys).map((k) => this.zload(k)));
    const exclude = new Set(others.flatMap((entries) => entries.map(([m]) => m)));
    return this.storeZ(destination, first.filter(([m]) => !exclude.has(m)));
  }

  async zscan(key: string, cursor: string | number, opts?: ScanCommandOptions): Promise<[string, (string | number)[]]> {
    const entries = await this.zload(key);
    const re = opts?.match ? globToRegExp(opts.match) : null;
    const [slice, next] = this.scanSlice(entries, cursor, opts);
    const flat = slice.filter(([m]) => !re || re.test(m)).flatMap(([m, s]) => [this.de<string | number>(m) as string | number, s]);
    return [next, flat];
  }
}

const TRANSACTIONAL: Array<[string, ((args: unknown[]) => boolean)?]> = [
  ["mset", (args) => Object.keys((args[0] ?? {}) as object).length > 1],
  ["msetnx"],
  ["rename"],
  ["renamenx"],
  ["copy"],
  ["smove"],
  ["lmove"],
  ["sdiffstore"],
  ["sinterstore"],
  ["sunionstore"],
  ["zunionstore"],
  ["zinterstore"],
  ["zdiffstore"],
  ["del", (args) => normalizeKeys(args as string[]).length > 1],
];

for (const [name, applies] of TRANSACTIONAL) {
  const original = (Redis.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name];
  if (!original) continue;
  Object.defineProperty(Redis.prototype, name, {
    configurable: true,
    writable: true,
    value: function (this: Redis, ...args: unknown[]) {
      if (applies && !applies(args)) return original.apply(this, args);
      return (this as unknown as { transact: Redis["transact"] }).transact((scoped) => original.apply(scoped, args));
    },
  });
}
