import { invalidArgument } from "../errors.js";
import type { KvRecord, KvStore } from "../kv/store.js";
import { internals } from "../redis/redis.js";
import type { Redis } from "../redis/redis.js";

export type Unit = "ms" | "s" | "m" | "h" | "d" | "w";
export type Duration = `${number} ${Unit}` | `${number}${Unit}`;

export type EphemeralCache = {
  isBlocked: (identifier: string) => { blocked: boolean; reset: number };
  blockUntil: (identifier: string, reset: number) => void;
  set: (key: string, value: number) => void;
  get: (key: string) => number | null;
  incr: (key: string, incrementAmount?: number) => number;
  pop: (key: string) => void;
  empty: () => void;
  size: () => number;
};

export type RegionContext = {
  redis: Redis;
  cache?: EphemeralCache;
  dynamicLimits?: boolean;
  prefix: string;
};

export type MultiRegionContext = {
  regionContexts: Omit<RegionContext[], "cache">;
  cache?: EphemeralCache;
};

export type Context = RegionContext | MultiRegionContext;

export type RatelimitResponseType = "timeout" | "cacheBlock" | "denyList";
export type DeniedValue = string | undefined;

export type RatelimitResponse = {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
  pending: Promise<unknown>;
  reason?: RatelimitResponseType;
  deniedValue?: DeniedValue;
};

export type Algorithm<TContext> = () => {
  limit: (ctx: TContext, identifier: string, rate?: number, opts?: { cache?: EphemeralCache }) => Promise<RatelimitResponse>;
  getRemaining: (ctx: TContext, identifier: string) => Promise<{ remaining: number; reset: number; limit: number }>;
  resetTokens: (ctx: TContext, identifier: string) => Promise<void>;
};

export class Cache implements EphemeralCache {
  constructor(private readonly cache: Map<string, number>) {}

  isBlocked(identifier: string): { blocked: boolean; reset: number } {
    const reset = this.cache.get(identifier);
    if (reset === undefined) return { blocked: false, reset: 0 };
    if (reset < Date.now()) {
      this.cache.delete(identifier);
      return { blocked: false, reset: 0 };
    }
    return { blocked: true, reset };
  }

  blockUntil(identifier: string, reset: number): void {
    this.cache.set(identifier, reset);
  }

  set(key: string, value: number): void {
    this.cache.set(key, value);
  }

  get(key: string): number | null {
    return this.cache.get(key) ?? null;
  }

  incr(key: string, incrementAmount = 1): number {
    const value = (this.cache.get(key) ?? 0) + incrementAmount;
    this.cache.set(key, value);
    return value;
  }

  pop(key: string): void {
    this.cache.delete(key);
  }

  empty(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

export function toMs(duration: Duration): number {
  const match = /^(\d+(?:\.\d+)?)\s?(ms|s|m|h|d|w)$/.exec(duration);
  if (!match) throw invalidArgument("next-nats.ratelimit", "INVALID_DURATION", `Invalid duration "${duration}"`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] as Unit];
  return Number(match[1]) * unit;
}

export function dynamicLimitKey(prefix: string): string {
  return `${prefix}:dynamic:limit`;
}

function storeOf(ctx: RegionContext): KvStore {
  return ctx.redis[internals].store;
}

function keyOf(ctx: RegionContext, identifier: string): string {
  return `${ctx.prefix}:${identifier}`;
}

function parseState<T>(rec: KvRecord | null): T | undefined {
  return rec && typeof rec.v === "string" ? (JSON.parse(rec.v) as T) : undefined;
}

function record(state: unknown, x: number): KvRecord {
  return { t: "s", v: JSON.stringify(state), x };
}

async function tokensFor(ctx: RegionContext, configured: number): Promise<number> {
  if (!ctx.dynamicLimits) return configured;
  const rec = (await storeOf(ctx).read(dynamicLimitKey(ctx.prefix))).rec;
  const dynamic = rec && typeof rec.v === "string" ? Number(rec.v) : Number.NaN;
  return Number.isFinite(dynamic) ? dynamic : configured;
}

type Outcome = Omit<RatelimitResponse, "pending">;

async function guarded(
  ctx: RegionContext,
  identifier: string,
  tokens: number,
  compute: () => Promise<Outcome>,
): Promise<RatelimitResponse> {
  if (ctx.cache) {
    const { blocked, reset } = ctx.cache.isBlocked(identifier);
    if (blocked) return { success: false, limit: tokens, remaining: 0, reset, pending: Promise.resolve(), reason: "cacheBlock" };
  }
  const outcome = await compute();
  if (!outcome.success && ctx.cache) ctx.cache.blockUntil(identifier, outcome.reset);
  return { ...outcome, pending: Promise.resolve() };
}

interface Windows {
  w: number;
  cur: number;
  prev: number;
}

function roll(state: Windows | undefined, idx: number): Windows {
  if (!state) return { w: idx, cur: 0, prev: 0 };
  if (state.w === idx) return state;
  if (state.w === idx - 1) return { w: idx, cur: 0, prev: state.cur };
  return { w: idx, cur: 0, prev: 0 };
}

function fixedOp(store: KvStore, key: string, tokens: number, size: number, rate: number, now: number): Promise<Outcome> {
  const idx = Math.floor(now / size);
  const reset = (idx + 1) * size;
  return store.mutate(key, (cur) => {
    const state = roll(parseState<Windows>(cur), idx);
    const success = state.cur + rate <= tokens;
    const next = success ? { ...state, cur: state.cur + rate } : state;
    return {
      next: success ? record(next, reset + size) : undefined,
      result: { success, limit: tokens, remaining: Math.max(0, tokens - next.cur), reset },
    };
  });
}

function windowPeek(ctx: RegionContext, identifier: string, tokens: number, size: number, weighted: boolean) {
  return async () => {
    const now = Date.now();
    const idx = Math.floor(now / size);
    const state = roll(parseState<Windows>((await storeOf(ctx).read(keyOf(ctx, identifier))).rec), idx);
    const used = weighted ? Math.floor(state.prev * (1 - (now - idx * size) / size)) + state.cur : state.cur;
    return { limit: tokens, remaining: Math.max(0, tokens - used), reset: (idx + 1) * size };
  };
}

async function drop(ctx: RegionContext, identifier: string): Promise<void> {
  await storeOf(ctx).mutate(keyOf(ctx, identifier), (cur) => ({ next: cur ? null : undefined, result: undefined }));
}

export function fixedWindow(tokens: number, window: Duration): Algorithm<RegionContext> {
  const size = toMs(window);
  return () => ({
    limit: async (ctx, identifier, rate = 1) => {
      const limit = await tokensFor(ctx, tokens);
      return guarded(ctx, identifier, limit, () => fixedOp(storeOf(ctx), keyOf(ctx, identifier), limit, size, rate, Date.now()));
    },
    getRemaining: async (ctx, identifier) => windowPeek(ctx, identifier, await tokensFor(ctx, tokens), size, false)(),
    resetTokens: (ctx, identifier) => drop(ctx, identifier),
  });
}

export function slidingWindow(tokens: number, window: Duration): Algorithm<RegionContext> {
  const size = toMs(window);
  return () => ({
    limit: async (ctx, identifier, rate = 1) => {
      const limit = await tokensFor(ctx, tokens);
      return guarded(ctx, identifier, limit, () => {
        const now = Date.now();
        const idx = Math.floor(now / size);
        const reset = (idx + 1) * size;
        return storeOf(ctx).mutate(keyOf(ctx, identifier), (cur) => {
          const state = roll(parseState<Windows>(cur), idx);
          const weighted = Math.floor(state.prev * (1 - (now - idx * size) / size)) + state.cur;
          const success = weighted + rate <= limit;
          return {
            next: success ? record({ ...state, cur: state.cur + rate }, reset + size) : undefined,
            result: { success, limit, remaining: Math.max(0, limit - weighted - (success ? rate : 0)), reset },
          };
        });
      });
    },
    getRemaining: async (ctx, identifier) => windowPeek(ctx, identifier, await tokensFor(ctx, tokens), size, true)(),
    resetTokens: (ctx, identifier) => drop(ctx, identifier),
  });
}

interface Bucket {
  tokens: number;
  at: number;
}

export function tokenBucket(refillRate: number, interval: Duration, maxTokens: number): Algorithm<RegionContext> {
  const size = toMs(interval);
  const ttlMs = Math.ceil(maxTokens / refillRate) * size + size;
  const refill = (state: Bucket | undefined, max: number, now: number): Bucket => {
    if (!state) return { tokens: max, at: now };
    const intervals = Math.floor((now - state.at) / size);
    if (intervals <= 0) return state;
    const refilled = Math.min(max, state.tokens + intervals * refillRate);
    return { tokens: refilled, at: refilled === max ? now : state.at + intervals * size };
  };
  return () => ({
    limit: async (ctx, identifier, rate = 1) => {
      const max = await tokensFor(ctx, maxTokens);
      return guarded(ctx, identifier, max, () => {
        const now = Date.now();
        return storeOf(ctx).mutate(keyOf(ctx, identifier), (cur) => {
          const state = refill(parseState<Bucket>(cur), max, now);
          const success = state.tokens >= rate;
          const next = success ? { ...state, tokens: state.tokens - rate } : state;
          return {
            next: record(next, now + ttlMs),
            result: { success, limit: max, remaining: next.tokens, reset: next.at + size },
          };
        });
      });
    },
    getRemaining: async (ctx, identifier) => {
      const max = await tokensFor(ctx, maxTokens);
      const state = refill(parseState<Bucket>((await storeOf(ctx).read(keyOf(ctx, identifier))).rec), max, Date.now());
      return { limit: max, remaining: state.tokens, reset: state.at + size };
    },
    resetTokens: (ctx, identifier) => drop(ctx, identifier),
  });
}

export function cachedFixedWindow(tokens: number, window: Duration): Algorithm<RegionContext> {
  const size = toMs(window);
  return () => ({
    limit: async (ctx, identifier, rate = 1) => {
      const cache = ctx.cache;
      if (!cache) throw new Error("This algorithm requires a cache");
      const limit = await tokensFor(ctx, tokens);
      const now = Date.now();
      const bucket = Math.floor(now / size);
      const reset = (bucket + 1) * size;
      const counter = `${identifier}:${bucket}`;
      const key = keyOf(ctx, identifier);
      const cached = cache.get(counter);
      if (cached !== null) {
        if (cached + rate > limit) return { success: false, limit, remaining: 0, reset, pending: Promise.resolve() };
        cache.incr(counter, rate);
        const pending = fixedOp(storeOf(ctx), key, limit, size, rate, now);
        return { success: true, limit, remaining: limit - cached - rate, reset, pending };
      }
      const outcome = await fixedOp(storeOf(ctx), key, limit, size, rate, now);
      cache.set(counter, limit - outcome.remaining);
      return { ...outcome, pending: Promise.resolve() };
    },
    getRemaining: async (ctx, identifier) => windowPeek(ctx, identifier, await tokensFor(ctx, tokens), size, false)(),
    resetTokens: async (ctx, identifier) => {
      ctx.cache?.pop(`${identifier}:${Math.floor(Date.now() / size)}`);
      await drop(ctx, identifier);
    },
  });
}
