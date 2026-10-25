import "server-only";
import { kv as defaultKv, type NatsKv } from "../kv/index.js";
import type { KvRecord, KvStore } from "../kv/store.js";
import { invalidArgument } from "../errors.js";

export type Unit = "ms" | "s" | "m" | "h" | "d";
export type Duration = `${number} ${Unit}` | `${number}${Unit}`;

export interface RatelimitResponse {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
  pending: Promise<unknown>;
}

export interface RatelimitStatus {
  remaining: number;
  reset: number;
  limit: number;
}

type Outcome = Omit<RatelimitResponse, "pending">;

export interface Algorithm {
  limit(store: KvStore, key: string, rate: number, now: number): Promise<Outcome>;
  peek(store: KvStore, key: string, now: number): Promise<RatelimitStatus>;
  readonly ttlMs: number;
}

export function toMs(duration: Duration): number {
  const match = /^(\d+(?:\.\d+)?)\s?(ms|s|m|h|d)$/.exec(duration);
  if (!match) throw invalidArgument("next-nats.ratelimit", "INVALID_DURATION", `Invalid duration "${duration}"`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as Unit];
  return Number(match[1]) * unit;
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

function asState<T>(rec: KvRecord | null): T | undefined {
  return rec ? (rec.v as T) : undefined;
}

function fixedWindow(tokens: number, window: Duration): Algorithm {
  const size = toMs(window);
  return {
    ttlMs: size * 2,
    limit: (store, key, rate, now) => {
      const idx = Math.floor(now / size);
      const reset = (idx + 1) * size;
      return store.mutate(key, (cur) => {
        const state = roll(asState<Windows>(cur), idx);
        const success = state.cur + rate <= tokens;
        const next = success ? { ...state, cur: state.cur + rate } : state;
        return {
          next: success ? { t: "s", v: next, x: reset + size } : undefined,
          result: { success, limit: tokens, remaining: Math.max(0, tokens - next.cur), reset },
        };
      });
    },
    peek: async (store, key, now) => {
      const idx = Math.floor(now / size);
      const state = roll(asState<Windows>((await store.read(key)).rec), idx);
      return { limit: tokens, remaining: Math.max(0, tokens - state.cur), reset: (idx + 1) * size };
    },
  };
}

function slidingWindow(tokens: number, window: Duration): Algorithm {
  const size = toMs(window);
  const used = (state: Windows, now: number, idx: number) =>
    Math.floor(state.prev * (1 - (now - idx * size) / size)) + state.cur;
  return {
    ttlMs: size * 2,
    limit: (store, key, rate, now) => {
      const idx = Math.floor(now / size);
      const reset = (idx + 1) * size;
      return store.mutate(key, (cur) => {
        const state = roll(asState<Windows>(cur), idx);
        const weighted = used(state, now, idx);
        const success = weighted + rate <= tokens;
        return {
          next: success ? { t: "s", v: { ...state, cur: state.cur + rate }, x: reset + size } : undefined,
          result: { success, limit: tokens, remaining: Math.max(0, tokens - weighted - (success ? rate : 0)), reset },
        };
      });
    },
    peek: async (store, key, now) => {
      const idx = Math.floor(now / size);
      const state = roll(asState<Windows>((await store.read(key)).rec), idx);
      return { limit: tokens, remaining: Math.max(0, tokens - used(state, now, idx)), reset: (idx + 1) * size };
    },
  };
}

interface Bucket {
  tokens: number;
  at: number;
}

function tokenBucket(refillRate: number, interval: Duration, maxTokens: number): Algorithm {
  const size = toMs(interval);
  const refill = (state: Bucket | undefined, now: number): Bucket => {
    if (!state) return { tokens: maxTokens, at: now };
    const intervals = Math.floor((now - state.at) / size);
    if (intervals <= 0) return state;
    const tokens = Math.min(maxTokens, state.tokens + intervals * refillRate);
    return { tokens, at: tokens === maxTokens ? now : state.at + intervals * size };
  };
  const ttlMs = Math.ceil(maxTokens / refillRate) * size + size;
  return {
    ttlMs,
    limit: (store, key, rate, now) =>
      store.mutate(key, (cur) => {
        const state = refill(asState<Bucket>(cur), now);
        const success = state.tokens >= rate;
        const next = success ? { ...state, tokens: state.tokens - rate } : state;
        return {
          next: { t: "s", v: next, x: now + ttlMs },
          result: { success, limit: maxTokens, remaining: next.tokens, reset: next.at + size },
        };
      }),
    peek: async (store, key, now) => {
      const state = refill(asState<Bucket>((await store.read(key)).rec), now);
      return { limit: maxTokens, remaining: state.tokens, reset: state.at + size };
    },
  };
}

export interface RatelimitConfig {
  limiter: Algorithm;
  kv?: NatsKv;
  prefix?: string;
}

export class Ratelimit {
  private readonly limiter: Algorithm;
  private readonly store: KvStore;
  private readonly prefix: string;

  constructor(config: RatelimitConfig) {
    this.limiter = config.limiter;
    this.store = (config.kv ?? defaultKv).store;
    this.prefix = config.prefix ?? "ratelimit";
  }

  static fixedWindow = fixedWindow;
  static slidingWindow = slidingWindow;
  static tokenBucket = tokenBucket;

  private key(identifier: string): string {
    return `${this.prefix}:${identifier}`;
  }

  async limit(identifier: string, req?: { rate?: number }): Promise<RatelimitResponse> {
    const outcome = await this.limiter.limit(this.store, this.key(identifier), req?.rate ?? 1, Date.now());
    return { ...outcome, pending: Promise.resolve() };
  }

  async blockUntilReady(identifier: string, timeout: number): Promise<RatelimitResponse> {
    if (timeout <= 0) throw invalidArgument("next-nats.ratelimit", "INVALID_TIMEOUT", "timeout must be positive");
    const deadline = Date.now() + timeout;
    let res = await this.limit(identifier);
    while (!res.success) {
      if (res.reset > deadline) return res;
      await new Promise((r) => setTimeout(r, Math.max(1, Math.min(res.reset, deadline) - Date.now())));
      res = await this.limit(identifier);
      if (Date.now() > deadline) return res;
    }
    return res;
  }

  getRemaining(identifier: string): Promise<RatelimitStatus> {
    return this.limiter.peek(this.store, this.key(identifier), Date.now());
  }

  async resetUsedTokens(identifier: string): Promise<void> {
    await this.store.mutate(this.key(identifier), (cur) => ({ next: cur ? null : undefined, result: undefined }));
  }
}
