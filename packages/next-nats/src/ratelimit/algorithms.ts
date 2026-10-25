import { invalidArgument } from "../errors.js";
import type { KvRecord, Store } from "../kv/store.js";
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

function storeOf(ctx: RegionContext): Store {
  return ctx.redis[internals].store;
}

function parseState<T>(rec: KvRecord | null): T | undefined {
  return rec && typeof rec.v === "string" ? (JSON.parse(rec.v) as T) : undefined;
}

function record(state: unknown, x?: number): KvRecord {
  return { t: "s", v: JSON.stringify(state), ...(x !== undefined && { x }) };
}

async function tokensFor(ctx: RegionContext, configured: number): Promise<number> {
  if (!ctx.dynamicLimits) return configured;
  const rec = (await storeOf(ctx).read(dynamicLimitKey(ctx.prefix))).rec;
  const dynamic = rec && typeof rec.v === "string" ? Number(rec.v) : Number.NaN;
  return Number.isFinite(dynamic) ? dynamic : configured;
}

function cachedBlock(ctx: RegionContext, identifier: string, rate: number, limit: number): RatelimitResponse | undefined {
  if (!ctx.cache || rate <= 0) return undefined;
  const { blocked, reset } = ctx.cache.isBlocked(identifier);
  if (!blocked) return undefined;
  return { success: false, limit, remaining: 0, reset, pending: Promise.resolve(), reason: "cacheBlock" };
}

function remember(ctx: RegionContext, identifier: string, success: boolean, rate: number, reset: number): void {
  if (!ctx.cache) return;
  if (!success) ctx.cache.blockUntil(identifier, reset);
  else if (rate < 0) ctx.cache.pop(identifier);
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

function weightedPrev(state: Windows, now: number, size: number, idx: number): number {
  return Math.floor((1 - (now - idx * size) / size) * state.prev);
}

async function incrementWindow(store: Store, key: string, size: number, rate: number, now: number): Promise<number> {
  const idx = Math.floor(now / size);
  return store.mutate(key, (cur) => {
    const state = roll(parseState<Windows>(cur), idx);
    const next = { ...state, cur: state.cur + rate };
    return { next: record(next, (idx + 1) * size), result: next.cur };
  });
}

async function readWindow(ctx: RegionContext, key: string, size: number, now: number): Promise<Windows> {
  return roll(parseState<Windows>((await storeOf(ctx).read(key)).rec), Math.floor(now / size));
}

async function drop(ctx: RegionContext, identifier: string): Promise<void> {
  await storeOf(ctx).mutate(identifier, (cur) => ({ next: cur ? null : undefined, result: undefined }));
}

export function fixedWindow(tokens: number, window: Duration): Algorithm<RegionContext> {
  const size = toMs(window);
  return () => ({
    limit: async (ctx, identifier, rate = 1) => {
      const blocked = cachedBlock(ctx, identifier, rate, tokens);
      if (blocked) return blocked;
      const effective = await tokensFor(ctx, tokens);
      const now = Date.now();
      const used = await incrementWindow(storeOf(ctx), identifier, size, rate, now);
      const success = used <= effective;
      const reset = (Math.floor(now / size) + 1) * size;
      remember(ctx, identifier, success, rate, reset);
      return { success, limit: effective, remaining: Math.max(0, effective - used), reset, pending: Promise.resolve() };
    },
    getRemaining: async (ctx, identifier) => {
      const effective = await tokensFor(ctx, tokens);
      const now = Date.now();
      const state = await readWindow(ctx, identifier, size, now);
      return { remaining: Math.max(0, effective - state.cur), reset: (Math.floor(now / size) + 1) * size, limit: effective };
    },
    resetTokens: async (ctx, identifier) => {
      ctx.cache?.pop(identifier);
      await drop(ctx, identifier);
    },
  });
}

export function slidingWindow(tokens: number, window: Duration): Algorithm<RegionContext> {
  const size = toMs(window);
  return () => ({
    limit: async (ctx, identifier, rate = 1) => {
      const blocked = cachedBlock(ctx, identifier, rate, tokens);
      if (blocked) return blocked;
      const effective = await tokensFor(ctx, tokens);
      const now = Date.now();
      const idx = Math.floor(now / size);
      const reset = (idx + 1) * size;
      const remaining = await storeOf(ctx).mutate(identifier, (cur) => {
        const state = roll(parseState<Windows>(cur), idx);
        const prev = weightedPrev(state, now, size, idx);
        if (rate > 0 && prev + state.cur >= effective) return { next: undefined, result: -1 };
        const cursor = state.cur + rate;
        return {
          next: record({ ...state, cur: cursor }, (idx + 2) * size + 1000),
          result: effective - (cursor + prev),
        };
      });
      const success = remaining >= 0;
      remember(ctx, identifier, success, rate, reset);
      return { success, limit: effective, remaining: Math.max(0, remaining), reset, pending: Promise.resolve() };
    },
    getRemaining: async (ctx, identifier) => {
      const effective = await tokensFor(ctx, tokens);
      const now = Date.now();
      const idx = Math.floor(now / size);
      const state = await readWindow(ctx, identifier, size, now);
      const used = weightedPrev(state, now, size, idx) + state.cur;
      return { remaining: Math.max(0, effective - used), reset: (idx + 1) * size, limit: effective };
    },
    resetTokens: async (ctx, identifier) => {
      ctx.cache?.pop(identifier);
      await drop(ctx, identifier);
    },
  });
}

interface Bucket {
  tokens: number;
  at: number;
}

export function tokenBucket(refillRate: number, interval: Duration, maxTokens: number): Algorithm<RegionContext> {
  const size = toMs(interval);
  return () => ({
    limit: async (ctx, identifier, rate = 1) => {
      const blocked = cachedBlock(ctx, identifier, rate, maxTokens);
      if (blocked) return blocked;
      const effective = await tokensFor(ctx, maxTokens);
      const now = Date.now();
      const outcome = await storeOf(ctx).mutate(identifier, (cur) => {
        const found = parseState<Bucket>(cur);
        let at = found ? found.at : now;
        let available = found ? found.tokens : effective;
        if (now >= at + size) {
          const refills = Math.floor((now - at) / size);
          available = Math.min(effective, available + refills * refillRate);
          at += refills * size;
        }
        if (rate > 0 && available < rate) return { next: undefined, result: { remaining: -1, reset: at + size } };
        const remaining = available - rate;
        const ttl = Math.ceil((effective - remaining) / refillRate) * size;
        return {
          next: record({ tokens: remaining, at }, ttl > 0 ? now + ttl : undefined),
          result: { remaining, reset: at + size },
        };
      });
      const success = outcome.remaining >= 0;
      remember(ctx, identifier, success, rate, outcome.reset);
      return { success, limit: effective, remaining: Math.max(0, outcome.remaining), reset: outcome.reset, pending: Promise.resolve() };
    },
    getRemaining: async (ctx, identifier) => {
      const effective = await tokensFor(ctx, maxTokens);
      const found = parseState<Bucket>((await storeOf(ctx).read(identifier)).rec);
      if (!found) return { remaining: effective, reset: Date.now() + size, limit: effective };
      return { remaining: Math.max(0, found.tokens), reset: found.at + size, limit: effective };
    },
    resetTokens: async (ctx, identifier) => {
      ctx.cache?.pop(identifier);
      await drop(ctx, identifier);
    },
  });
}

export function cachedFixedWindow(tokens: number, window: Duration): Algorithm<RegionContext> {
  const size = toMs(window);
  const bucketKey = (identifier: string, now: number) => `${identifier}:${Math.floor(now / size)}`;
  return () => ({
    limit: async (ctx, identifier, rate = 1) => {
      const cache = ctx.cache;
      if (!cache) throw new Error("This algorithm requires a cache");
      if (ctx.dynamicLimits) {
        console.warn("Warning: Dynamic limits are not yet supported for cachedFixedWindow algorithm. The dynamicLimits option will be ignored.");
      }
      const now = Date.now();
      const key = bucketKey(identifier, now);
      const reset = (Math.floor(now / size) + 1) * size;
      if (typeof cache.get(key) === "number") {
        const afterUpdate = cache.incr(key, rate);
        const success = afterUpdate <= tokens;
        const pending = success ? incrementWindow(storeOf(ctx), identifier, size, rate, now) : Promise.resolve();
        return { success, limit: tokens, remaining: tokens - afterUpdate, reset, pending };
      }
      const used = await incrementWindow(storeOf(ctx), identifier, size, rate, now);
      cache.set(key, used);
      const remaining = tokens - used;
      return { success: remaining >= 0, limit: tokens, remaining, reset, pending: Promise.resolve() };
    },
    getRemaining: async (ctx, identifier) => {
      const cache = ctx.cache;
      if (!cache) throw new Error("This algorithm requires a cache");
      const now = Date.now();
      const reset = (Math.floor(now / size) + 1) * size;
      const cached = cache.get(bucketKey(identifier, now));
      const used = typeof cached === "number" ? cached : (await readWindow(ctx, identifier, size, now)).cur;
      return { remaining: Math.max(0, tokens - used), reset, limit: tokens };
    },
    resetTokens: async (ctx, identifier) => {
      if (!ctx.cache) throw new Error("This algorithm requires a cache");
      ctx.cache.pop(bucketKey(identifier, Date.now()));
      await drop(ctx, identifier);
    },
  });
}
