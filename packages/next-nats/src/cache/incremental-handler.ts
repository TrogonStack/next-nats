import type {
  CacheHandlerContext,
  CacheHandlerValue,
} from "next/dist/server/lib/incremental-cache/index.js";
import type { IncrementalCacheValue } from "next/dist/server/response-cache/types.js";
import type { CacheControl } from "next/dist/server/lib/cache-control.js";
import type { NatsIncrementalCacheHandler } from "./incremental.js";

type SetContext = Parameters<NatsIncrementalCacheHandler["set"]>[2];
type GetContext = Parameters<NatsIncrementalCacheHandler["get"]>[1];

export class NatsCacheHandler {
  private inner?: Promise<NatsIncrementalCacheHandler>;

  constructor(private readonly ctx: Partial<CacheHandlerContext> = {}) {}

  private load(): Promise<NatsIncrementalCacheHandler> {
    this.inner ??= (
      process.env.NEXT_RUNTIME === "edge"
        ? Promise.reject(new Error("the NATS incremental cache handler is not available in the Edge runtime"))
        : import("./incremental.js")
    ).then((module) => new module.NatsIncrementalCacheHandler(this.ctx));
    return this.inner;
  }

  async close(): Promise<void> {
    if (process.env.NEXT_RUNTIME === "edge" || !this.inner) return;
    await (await this.inner).close();
    this.inner = undefined;
  }

  async get(key: string, ctx: GetContext): Promise<CacheHandlerValue | null> {
    if (process.env.NEXT_RUNTIME === "edge") return null;
    return (await this.load()).get(key, ctx);
  }

  async set(key: string, data: IncrementalCacheValue | null, ctx: SetContext & { cacheControl?: CacheControl }): Promise<void> {
    if (process.env.NEXT_RUNTIME === "edge") return;
    await (await this.load()).set(key, data, ctx);
  }

  async revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
    if (process.env.NEXT_RUNTIME === "edge") return;
    await (await this.load()).revalidateTag(tags, durations);
  }

  resetRequestCache(): void {}
}

export default NatsCacheHandler;
