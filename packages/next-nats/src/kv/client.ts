import "server-only";
import { KvError, KvStore, type KvRecord, type KvStoreOptions } from "./store.js";
import { encodeKey, globToRegExp } from "./key.js";

export type KvValue = unknown;

export type SetOptions = {
  get?: boolean;
  nx?: boolean;
  xx?: boolean;
  keepTtl?: boolean;
  ex?: number;
  px?: number;
  exat?: number;
  pxat?: number;
};

export type ExpireOption = "NX" | "XX" | "GT" | "LT";

export type ScanOptions = { match?: string; count?: number; type?: "string" | "hash" };

const INTEGER = /^-?\d+$/;

function wrongType(): KvError {
  return new KvError("WRONGTYPE", "Operation against a key holding the wrong kind of value");
}

function asInteger(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && INTEGER.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new KvError("ERR", "value is not an integer or out of range");
}

function asFloat(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) throw new KvError("ERR", "value is not a valid float");
  return n;
}

function assertSerializable(value: unknown): void {
  if (value === undefined) throw new KvError("ERR", "undefined is not a storable value, use null");
}

function str(rec: KvRecord | null): KvRecord | null {
  if (rec && rec.t !== "s") throw wrongType();
  return rec;
}

function hash(rec: KvRecord | null): Record<string, unknown> | null {
  if (!rec) return null;
  if (rec.t !== "h") throw wrongType();
  return rec.v as Record<string, unknown>;
}

function withExpiry(rec: KvRecord, x: number | undefined): KvRecord {
  const { x: _drop, ...rest } = rec;
  return x === undefined ? rest : { ...rest, x };
}

function expiryFrom(opts: SetOptions, current: KvRecord | null, now: number): number | undefined {
  if (opts.ex !== undefined) return now + opts.ex * 1000;
  if (opts.px !== undefined) return now + opts.px;
  if (opts.exat !== undefined) return opts.exat * 1000;
  if (opts.pxat !== undefined) return opts.pxat;
  if (opts.keepTtl) return current?.x;
  return undefined;
}

export class NatsKv {
  readonly store: KvStore;

  constructor(options: KvStoreOptions) {
    this.store = new KvStore(options);
  }

  get bucket(): string {
    return this.store.bucket;
  }

  async get<T = KvValue>(key: string): Promise<T | null> {
    const { rec } = await this.store.read(key);
    return rec ? (str(rec)!.v as T) : null;
  }

  set<T = KvValue>(key: string, value: T, opts: SetOptions & { get: true }): Promise<T | null>;
  set(key: string, value: KvValue, opts?: SetOptions): Promise<"OK" | null>;
  async set(key: string, value: KvValue, opts: SetOptions = {}): Promise<unknown> {
    assertSerializable(value);
    const simple = !opts.nx && !opts.xx && !opts.keepTtl && !opts.get;
    if (simple) {
      const x = expiryFrom(opts, null, Date.now());
      if (x !== undefined && x <= Date.now()) {
        await this.del(key);
        return "OK";
      }
      await this.store.write(key, withExpiry({ t: "s", v: value }, x), undefined);
      return "OK";
    }
    return this.store.mutate(key, (cur) => {
      const previous = cur ? (cur.t === "s" ? cur.v : null) : null;
      if (opts.get && cur && cur.t !== "s") throw wrongType();
      const blocked = (opts.nx && cur) || (opts.xx && !cur);
      if (blocked) return { next: undefined, result: opts.get ? previous : null };
      const x = expiryFrom(opts, cur, Date.now());
      if (x !== undefined && x <= Date.now()) return { next: null, result: opts.get ? previous : "OK" };
      return { next: withExpiry({ t: "s", v: value }, x), result: opts.get ? previous : "OK" };
    });
  }

  async setnx(key: string, value: KvValue): Promise<0 | 1> {
    return (await this.set(key, value, { nx: true })) === "OK" ? 1 : 0;
  }

  async setex(key: string, seconds: number, value: KvValue): Promise<"OK"> {
    await this.set(key, value, { ex: seconds });
    return "OK";
  }

  async psetex(key: string, ms: number, value: KvValue): Promise<"OK"> {
    await this.set(key, value, { px: ms });
    return "OK";
  }

  async getset<T = KvValue>(key: string, value: T): Promise<T | null> {
    return this.set<T>(key, value, { get: true });
  }

  async getdel<T = KvValue>(key: string): Promise<T | null> {
    return this.store.mutate(key, (cur) => {
      if (!cur) return { next: undefined, result: null };
      return { next: null, result: str(cur)!.v as T };
    });
  }

  async mget<T extends unknown[]>(...keys: [string[]] | string[]): Promise<T> {
    const list = (Array.isArray(keys[0]) ? keys[0] : keys) as string[];
    return (await Promise.all(list.map((k) => this.get(k)))) as T;
  }

  async mset(entries: Record<string, KvValue>): Promise<"OK"> {
    await Promise.all(Object.entries(entries).map(([k, v]) => this.set(k, v)));
    return "OK";
  }

  async del(...keys: [string[]] | string[]): Promise<number> {
    const list = (Array.isArray(keys[0]) ? keys[0] : keys) as string[];
    const counts = await Promise.all(
      list.map((k) => this.store.mutate(k, (cur) => (cur ? { next: null, result: 1 } : { next: undefined, result: 0 }))),
    );
    return counts.reduce<number>((a, b) => a + b, 0);
  }

  async unlink(...keys: [string[]] | string[]): Promise<number> {
    return this.del(...keys);
  }

  async exists(...keys: [string[]] | string[]): Promise<number> {
    const list = (Array.isArray(keys[0]) ? keys[0] : keys) as string[];
    const found = await Promise.all(list.map(async (k) => (await this.store.read(k)).rec !== null));
    return found.filter(Boolean).length;
  }

  incrby(key: string, by: number): Promise<number> {
    return this.store.mutate(key, (cur) => {
      const base = cur ? asInteger(str(cur)!.v) : 0;
      const next = base + by;
      if (!Number.isSafeInteger(next)) throw new KvError("ERR", "increment or decrement would overflow");
      return { next: { ...(cur ?? { t: "s" as const }), t: "s", v: next }, result: next };
    });
  }

  incr(key: string): Promise<number> {
    return this.incrby(key, 1);
  }

  decr(key: string): Promise<number> {
    return this.incrby(key, -1);
  }

  decrby(key: string, by: number): Promise<number> {
    return this.incrby(key, -by);
  }

  incrbyfloat(key: string, by: number): Promise<number> {
    return this.store.mutate(key, (cur) => {
      const next = (cur ? asFloat(str(cur)!.v) : 0) + by;
      if (!Number.isFinite(next)) throw new KvError("ERR", "increment would produce NaN or Infinity");
      return { next: { ...(cur ?? { t: "s" as const }), t: "s", v: next }, result: next };
    });
  }

  private setExpiry(key: string, at: number, option?: ExpireOption): Promise<0 | 1> {
    return this.store.mutate<0 | 1>(key, (cur) => {
      if (!cur) return { next: undefined, result: 0 };
      if (option === "NX" && cur.x !== undefined) return { next: undefined, result: 0 };
      if (option === "XX" && cur.x === undefined) return { next: undefined, result: 0 };
      if (option === "GT" && (cur.x === undefined || at <= cur.x)) return { next: undefined, result: 0 };
      if (option === "LT" && cur.x !== undefined && at >= cur.x) return { next: undefined, result: 0 };
      if (at <= Date.now()) return { next: null, result: 1 };
      return { next: { ...cur, x: at }, result: 1 };
    });
  }

  expire(key: string, seconds: number, option?: ExpireOption): Promise<0 | 1> {
    return this.setExpiry(key, Date.now() + seconds * 1000, option);
  }

  pexpire(key: string, ms: number, option?: ExpireOption): Promise<0 | 1> {
    return this.setExpiry(key, Date.now() + ms, option);
  }

  expireat(key: string, unixSeconds: number, option?: ExpireOption): Promise<0 | 1> {
    return this.setExpiry(key, unixSeconds * 1000, option);
  }

  pexpireat(key: string, unixMs: number, option?: ExpireOption): Promise<0 | 1> {
    return this.setExpiry(key, unixMs, option);
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

  async type(key: string): Promise<"none" | "string" | "hash"> {
    const { rec } = await this.store.read(key);
    return rec ? (rec.t === "s" ? "string" : "hash") : "none";
  }

  async keys(pattern = "*"): Promise<string[]> {
    const re = globToRegExp(pattern);
    const candidates = (await this.store.allKeys()).filter((k) => re.test(k));
    const live = await Promise.all(candidates.map(async (k) => ((await this.store.read(k)).rec ? k : null)));
    return live.filter((k): k is string => k !== null);
  }

  async scan(cursor: string | number, opts: ScanOptions = {}): Promise<[string, string[]]> {
    const start = Number(cursor);
    if (!Number.isInteger(start) || start < 0) throw new KvError("ERR", "invalid cursor");
    const count = opts.count ?? 10;
    const all = await this.store.allKeys();
    const slice = all.slice(start, start + count);
    const next = start + count >= all.length ? "0" : String(start + count);
    const re = opts.match ? globToRegExp(opts.match) : null;
    const picked = await Promise.all(
      slice.map(async (k) => {
        if (re && !re.test(k)) return null;
        const { rec } = await this.store.read(k);
        if (!rec) return null;
        if (opts.type && (opts.type === "string" ? "s" : "h") !== rec.t) return null;
        return k;
      }),
    );
    return [next, picked.filter((k): k is string => k !== null)];
  }

  async dbsize(): Promise<number> {
    return (await this.keys()).length;
  }

  async flushdb(): Promise<"OK"> {
    const kv = await this.store.kv();
    for (const k of await this.store.allKeys()) {
      await kv.purge(encodeKey(k));
    }
    return "OK";
  }

  hset(key: string, fields: Record<string, KvValue>): Promise<number> {
    for (const v of Object.values(fields)) assertSerializable(v);
    if (Object.keys(fields).length === 0) throw new KvError("ERR", "wrong number of arguments for 'hset' command");
    return this.store.mutate(key, (cur) => {
      const existing = hash(cur) ?? {};
      const added = Object.keys(fields).filter((f) => !(f in existing)).length;
      return { next: { ...(cur ?? { t: "h" as const, v: {} }), t: "h", v: { ...existing, ...fields } }, result: added };
    });
  }

  hsetnx(key: string, field: string, value: KvValue): Promise<0 | 1> {
    assertSerializable(value);
    return this.store.mutate<0 | 1>(key, (cur) => {
      const existing = hash(cur) ?? {};
      if (field in existing) return { next: undefined, result: 0 };
      return { next: { ...(cur ?? { t: "h" as const, v: {} }), t: "h", v: { ...existing, [field]: value } }, result: 1 };
    });
  }

  async hget<T = KvValue>(key: string, field: string): Promise<T | null> {
    const h = hash((await this.store.read(key)).rec);
    return h && field in h ? (h[field] as T) : null;
  }

  async hgetall<T extends Record<string, unknown> = Record<string, unknown>>(key: string): Promise<T | null> {
    const h = hash((await this.store.read(key)).rec);
    return h && Object.keys(h).length > 0 ? (h as T) : null;
  }

  async hmget<T extends Record<string, unknown> = Record<string, unknown>>(key: string, ...fields: string[]): Promise<T | null> {
    const h = hash((await this.store.read(key)).rec);
    if (!h) return null;
    const out: Record<string, unknown> = {};
    for (const f of fields) if (f in h) out[f] = h[f];
    return Object.keys(out).length > 0 ? (out as T) : null;
  }

  hdel(key: string, ...fields: string[]): Promise<number> {
    return this.store.mutate(key, (cur) => {
      const h = hash(cur);
      if (!h) return { next: undefined, result: 0 };
      const removed = fields.filter((f) => f in h);
      if (removed.length === 0) return { next: undefined, result: 0 };
      const rest = Object.fromEntries(Object.entries(h).filter(([f]) => !fields.includes(f)));
      return { next: Object.keys(rest).length === 0 ? null : { ...cur!, v: rest }, result: removed.length };
    });
  }

  hincrby(key: string, field: string, by: number): Promise<number> {
    return this.store.mutate(key, (cur) => {
      const existing = hash(cur) ?? {};
      const next = (field in existing ? asInteger(existing[field]) : 0) + by;
      if (!Number.isSafeInteger(next)) throw new KvError("ERR", "increment or decrement would overflow");
      return { next: { ...(cur ?? { t: "h" as const, v: {} }), t: "h", v: { ...existing, [field]: next } }, result: next };
    });
  }

  async hexists(key: string, field: string): Promise<0 | 1> {
    const h = hash((await this.store.read(key)).rec);
    return h && field in h ? 1 : 0;
  }

  async hkeys(key: string): Promise<string[]> {
    return Object.keys(hash((await this.store.read(key)).rec) ?? {});
  }

  async hvals(key: string): Promise<unknown[]> {
    return Object.values(hash((await this.store.read(key)).rec) ?? {});
  }

  async hlen(key: string): Promise<number> {
    return Object.keys(hash((await this.store.read(key)).rec) ?? {}).length;
  }
}

export function createKv(options: KvStoreOptions): NatsKv {
  return new NatsKv(options);
}
