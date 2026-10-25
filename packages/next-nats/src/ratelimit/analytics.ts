import { UnsupportedCommandError } from "../redis/errors.js";
import type { Redis } from "../redis/redis.js";

export type Geo = {
  country?: string;
  city?: string;
  region?: string;
  ip?: string;
};

export type EventSuccess = boolean | "denied";

export type Event = Geo & {
  identifier: string;
  time: number;
  success: EventSuccess;
};

export type AnalyticsConfig = {
  redis: Redis;
  prefix?: string;
};

export type Aggregate = Record<string, unknown> & { time: number };

export class Analytics {
  private readonly redis: Redis;
  private readonly table: string;

  constructor(config: AnalyticsConfig) {
    this.redis = config.redis;
    this.table = `${config.prefix ?? "@upstash/ratelimit"}:analytics`;
  }

  extractGeo(req: { geo?: Geo; cf?: Geo }): Geo {
    return req.geo ?? req.cf ?? {};
  }

  async record(event: Event): Promise<void> {
    const outcome = event.success === "denied" ? "denied" : event.success ? "success" : "blocked";
    await this.redis.hincrby(`${this.table}:usage`, `${event.identifier}\u0000${outcome}`, 1);
  }

  async getUsage(_cutoff = 0): Promise<Record<string, { success: number; blocked: number }>> {
    const rows = (await this.redis.hgetall<Record<string, number>>(`${this.table}:usage`)) ?? {};
    const usage: Record<string, { success: number; blocked: number }> = {};
    for (const [field, count] of Object.entries(rows)) {
      const [identifier = "", outcome = ""] = field.split("\u0000");
      const entry = (usage[identifier] ??= { success: 0, blocked: 0 });
      if (outcome === "success") entry.success += Number(count);
      else entry.blocked += Number(count);
    }
    return usage;
  }

  async series(_filter: string, _cutoff: number): Promise<Aggregate[]> {
    throw new UnsupportedCommandError("Analytics.series");
  }

  async getUsageOverTime(_timestampCount: number, _groupby: string): Promise<Aggregate[]> {
    throw new UnsupportedCommandError("Analytics.getUsageOverTime");
  }

  async getMostAllowedBlocked(_timestampCount: number, _getTop?: number, _checkAtMost?: number): Promise<never> {
    throw new UnsupportedCommandError("Analytics.getMostAllowedBlocked");
  }
}
