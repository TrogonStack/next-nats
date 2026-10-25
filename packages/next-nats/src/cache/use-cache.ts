import type { CacheEntry, CacheHandler } from "next/cache.js";
import { getBackend, type BackendOptions, type CacheBackend } from "./backend.js";

export interface UseCacheMeta {
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class NatsUseCacheHandler implements CacheHandler {
  private readonly pending = new Map<string, Promise<void>>();
  private backend?: Promise<CacheBackend<UseCacheMeta>>;

  constructor(private readonly options: BackendOptions = {}) {}

  private open(): Promise<CacheBackend<UseCacheMeta>> {
    this.backend ??= getBackend<UseCacheMeta>("data", this.options);
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

  async get(cacheKey: string, softTags: string[]): Promise<undefined | CacheEntry> {
    try {
      const { tags, entries } = await this.open();
      await tags.ready;
      const pending = this.pending.get(cacheKey);
      if (pending) await pending;
      const stored = await entries.get(cacheKey);
      if (!stored) return undefined;
      const meta = stored.meta;
      if (meta.expire < 0) return undefined;
      const all = [...meta.tags, ...softTags];
      if (tags.isExpired(all, meta.timestamp)) return undefined;
      const revalidate = tags.isStale(all, meta.timestamp) ? -1 : meta.revalidate;
      return { ...meta, revalidate, value: streamFromBytes(stored.body) };
    } catch (err) {
      console.warn("next-nats cache get failed", cacheKey, err);
      return undefined;
    }
  }

  async set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void> {
    let resolvePending: () => void = () => undefined;
    this.pending.set(
      cacheKey,
      new Promise<void>((resolve) => {
        resolvePending = resolve;
      }),
    );
    try {
      const entry = await pendingEntry;
      if (!process.env.__NEXT_DEV_SERVER && entry.expire === 0) return;
      const body = await streamToBytes(entry.value);
      const { value: _value, ...meta } = entry;
      const { entries } = await this.open();
      await entries.set(cacheKey, meta, body);
    } catch (err) {
      console.warn("next-nats cache set failed", cacheKey, err);
    } finally {
      resolvePending();
      this.pending.delete(cacheKey);
    }
  }

  async refreshTags(): Promise<void> {
    try {
      await (await this.open()).tags.ready;
    } catch (err) {
      console.warn("next-nats cache refreshTags failed", err);
    }
  }

  async getExpiration(tags: string[]): Promise<number> {
    try {
      const backend = await this.open();
      await backend.tags.ready;
      return backend.tags.maxExpired(tags);
    } catch (err) {
      console.warn("next-nats cache getExpiration failed", err);
      return 0;
    }
  }

  async updateTags(tags: string[], durations?: { expire?: number }): Promise<void> {
    const { tags: store } = await this.open();
    await store.update(tags, durations);
  }
}

export function createUseCacheHandler(options: BackendOptions = {}): NatsUseCacheHandler {
  return new NatsUseCacheHandler(options);
}
