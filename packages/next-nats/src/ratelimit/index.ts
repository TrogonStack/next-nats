import "server-only";
import { UnsupportedCommandError } from "../redis/errors.js";
import type { Redis } from "../redis/redis.js";
import { Analytics } from "./analytics.js";
import type { Geo } from "./analytics.js";
import {
  Cache,
  cachedFixedWindow,
  dynamicLimitKey,
  fixedWindow,
  slidingWindow,
  tokenBucket,
  toMs,
} from "./algorithms.js";
import type { Algorithm, Duration, MultiRegionContext, RatelimitResponse, RegionContext } from "./algorithms.js";

export { Analytics } from "./analytics.js";
export type { AnalyticsConfig, Geo } from "./analytics.js";
export type {
  Algorithm,
  DeniedValue,
  Duration,
  EphemeralCache,
  RatelimitResponse,
  RatelimitResponseType,
  Unit,
} from "./algorithms.js";
export { toMs } from "./algorithms.js";
export * as IpDenyList from "./deny-list.js";

export type LimitOptions = {
  geo?: Geo;
  rate?: number;
  ip?: string;
  userAgent?: string;
  country?: string;
};

export type RatelimitConfig = {
  redis: Redis;
  limiter: Algorithm<RegionContext>;
  prefix?: string;
  ephemeralCache?: Map<string, number> | false;
  timeout?: number;
  analytics?: boolean;
  cacheScripts?: boolean;
  enableProtection?: boolean;
  denyListThreshold?: number;
  dynamicLimits?: boolean;
  enableTelemetry?: boolean;
};

export class Ratelimit {
  protected readonly limiter: ReturnType<Algorithm<RegionContext>>;
  protected readonly ctx: RegionContext;
  protected readonly prefix: string;
  protected readonly timeout: number;
  protected readonly primaryRedis: Redis;
  protected readonly analytics?: Analytics;
  protected readonly dynamicLimits: boolean;

  constructor(config: RatelimitConfig) {
    if (config.enableProtection) throw new UnsupportedCommandError("Ratelimit enableProtection");
    this.prefix = config.prefix ?? "@upstash/ratelimit";
    this.timeout = config.timeout ?? 5000;
    this.primaryRedis = config.redis;
    this.dynamicLimits = config.dynamicLimits ?? false;
    this.limiter = config.limiter();
    this.ctx = {
      redis: config.redis,
      prefix: this.prefix,
      dynamicLimits: this.dynamicLimits,
      ...(config.ephemeralCache !== false && { cache: new Cache(config.ephemeralCache ?? new Map<string, number>()) }),
    };
    if (config.analytics) this.analytics = new Analytics({ redis: config.redis, prefix: this.prefix });
  }

  static fixedWindow(tokens: number, window: Duration): Algorithm<RegionContext> {
    return fixedWindow(tokens, window);
  }

  static slidingWindow(tokens: number, window: Duration): Algorithm<RegionContext> {
    return slidingWindow(tokens, window);
  }

  static tokenBucket(refillRate: number, interval: Duration, maxTokens: number): Algorithm<RegionContext> {
    return tokenBucket(refillRate, interval, maxTokens);
  }

  static cachedFixedWindow(tokens: number, window: Duration): Algorithm<RegionContext> {
    return cachedFixedWindow(tokens, window);
  }

  limit = async (identifier: string, req?: LimitOptions): Promise<RatelimitResponse> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const attempts: Promise<RatelimitResponse>[] = [this.limiter.limit(this.ctx, identifier, req?.rate, { cache: this.ctx.cache })];
      if (this.timeout > 0) {
        attempts.push(
          new Promise<RatelimitResponse>((resolve) => {
            timer = setTimeout(
              () => resolve({ success: true, limit: 0, remaining: 0, reset: 0, pending: Promise.resolve(), reason: "timeout" }),
              this.timeout,
            );
          }),
        );
      }
      const response = await Promise.race(attempts);
      return this.submitAnalytics(response, identifier, req);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  blockUntilReady = async (identifier: string, timeout: number): Promise<RatelimitResponse> => {
    if (timeout <= 0) throw new Error("timeout must be positive");
    const deadline = Date.now() + timeout;
    let res: RatelimitResponse;
    while (true) {
      res = await this.limit(identifier);
      if (res.success) break;
      if (res.reset === 0) throw new Error("This should not happen");
      const wait = Math.min(res.reset, deadline) - Date.now();
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)));
      if (Date.now() > deadline) break;
    }
    return res;
  };

  resetUsedTokens = async (identifier: string): Promise<void> => {
    await this.limiter.resetTokens(this.ctx, identifier);
  };

  getRemaining = (identifier: string): Promise<{ remaining: number; reset: number; limit: number }> =>
    this.limiter.getRemaining(this.ctx, identifier);

  setDynamicLimit = async (options: { limit: number | false }): Promise<void> => {
    if (!this.dynamicLimits) {
      throw new Error("dynamicLimits must be enabled in the Ratelimit constructor to use setDynamicLimit");
    }
    const key = dynamicLimitKey(this.prefix);
    if (options.limit === false) await this.primaryRedis.del(key);
    else await this.primaryRedis.set(key, options.limit);
  };

  getDynamicLimit = async (): Promise<{ dynamicLimit: number | null }> => {
    if (!this.dynamicLimits) {
      throw new Error("dynamicLimits must be enabled in the Ratelimit constructor to use getDynamicLimit");
    }
    return { dynamicLimit: await this.primaryRedis.get<number>(dynamicLimitKey(this.prefix)) };
  };

  private submitAnalytics(response: RatelimitResponse, identifier: string, req?: LimitOptions): RatelimitResponse {
    if (!this.analytics || response.reason === "timeout") return response;
    const recorded = this.analytics.record({
      identifier,
      time: Date.now(),
      success: response.success,
      ...(req?.geo ?? {}),
      ...(req?.ip !== undefined && { ip: req.ip }),
      ...(req?.country !== undefined && { country: req.country }),
    });
    return { ...response, pending: Promise.all([response.pending, recorded]) };
  }
}

export type MultiRegionRatelimitConfig = {
  redis: Redis[];
  limiter: Algorithm<MultiRegionContext>;
  prefix?: string;
  ephemeralCache?: Map<string, number> | false;
  timeout?: number;
  analytics?: boolean;
  cacheScripts?: boolean;
  dynamicLimits?: boolean;
  enableTelemetry?: boolean;
};

export class MultiRegionRatelimit {
  constructor(_config: MultiRegionRatelimitConfig) {
    throw new UnsupportedCommandError("MultiRegionRatelimit");
  }

  static fixedWindow(_tokens: number, _window: Duration): Algorithm<MultiRegionContext> {
    throw new UnsupportedCommandError("MultiRegionRatelimit.fixedWindow");
  }

  static slidingWindow(_tokens: number, _window: Duration): Algorithm<MultiRegionContext> {
    throw new UnsupportedCommandError("MultiRegionRatelimit.slidingWindow");
  }
}

