import type {
  CacheHandlerContext,
  CacheHandlerValue,
} from "next/dist/server/lib/incremental-cache/index.js";
import type { IncrementalCacheValue } from "next/dist/server/response-cache/types.js";
import type { CacheControl } from "next/dist/server/lib/cache-control.js";
import { getBackend, type BackendOptions, type CacheBackend } from "./backend.js";
import { pack, unpack } from "./pack.js";

export interface IncrementalMeta {
  lastModified: number;
  cacheControl?: CacheControl;
  tags: string[];
}

const NEXT_CACHE_TAGS_HEADER = "x-next-cache-tags";

function headerTags(value: IncrementalCacheValue | null): string[] {
  if (!value || !("headers" in value)) return [];
  const header = (value.headers as Record<string, unknown> | undefined)?.[NEXT_CACHE_TAGS_HEADER];
  return typeof header === "string" && header.length > 0 ? header.split(",") : [];
}

export class NatsIncrementalCacheHandler {
  private readonly revalidatedTags: string[];
  private backend?: Promise<CacheBackend<IncrementalMeta>>;

  constructor(
    ctx: Partial<CacheHandlerContext> = {},
    private readonly options: BackendOptions = {},
  ) {
    this.revalidatedTags = ctx.revalidatedTags ?? [];
  }

  private open(): Promise<CacheBackend<IncrementalMeta>> {
    this.backend ??= getBackend<IncrementalMeta>("isr", this.options);
    this.backend.catch(() => {
      this.backend = undefined;
    });
    return this.backend;
  }

  async close(): Promise<void> {
    if (!this.backend) return;
    (await this.backend).stop();
    this.backend = undefined;
  }

  async get(key: string, ctx: { kind: string; tags?: string[]; softTags?: string[] }): Promise<CacheHandlerValue | null> {
    try {
      const { tags, entries } = await this.open();
      await tags.ready;
      const stored = await entries.get(key);
      if (!stored) return null;
      const { meta } = stored;
      const value = unpack<IncrementalCacheValue | null>(stored.body);
      if (ctx.kind === "FETCH") {
        const combined = [...(ctx.tags ?? []), ...(ctx.softTags ?? [])];
        if (combined.some((tag) => this.revalidatedTags.includes(tag))) return null;
        if (tags.isExpired(combined, meta.lastModified)) return null;
      } else {
        const cacheTags = headerTags(value);
        if (cacheTags.length > 0 && tags.isExpired(cacheTags, meta.lastModified)) return null;
      }
      return {
        lastModified: meta.lastModified,
        value,
        ...(meta.cacheControl && { cacheControl: meta.cacheControl }),
      };
    } catch (err) {
      console.warn("next-nats incremental cache get failed", key, err);
      return null;
    }
  }

  async set(
    key: string,
    data: IncrementalCacheValue | null,
    ctx: { fetchCache?: boolean; tags?: string[]; cacheControl?: CacheControl },
  ): Promise<void> {
    try {
      const { entries } = await this.open();
      if (!data) {
        await entries.delete(key);
        return;
      }
      const tags = ctx.fetchCache ? (ctx.tags ?? []) : headerTags(data);
      const meta: IncrementalMeta = {
        lastModified: Date.now(),
        tags,
        ...(!ctx.fetchCache && ctx.cacheControl && { cacheControl: ctx.cacheControl }),
      };
      await entries.set(key, meta, pack(ctx.fetchCache && data.kind === "FETCH" ? { ...data, tags } : data));
    } catch (err) {
      console.warn("next-nats incremental cache set failed", key, err);
    }
  }

  async revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
    const list = typeof tags === "string" ? [tags] : tags;
    if (list.length === 0) return;
    const { tags: store } = await this.open();
    await store.update(list, durations);
  }

  resetRequestCache(): void {}
}

export function createIncrementalCacheHandler(
  options: BackendOptions = {},
): new (ctx?: Partial<CacheHandlerContext>) => NatsIncrementalCacheHandler {
  return class extends NatsIncrementalCacheHandler {
    constructor(ctx: Partial<CacheHandlerContext> = {}) {
      super(ctx, options);
    }
  };
}
