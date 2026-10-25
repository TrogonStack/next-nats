import type { KV } from "@nats-io/kv";
import { KvWatchInclude } from "@nats-io/kv";
import { tagsManifest } from "next/dist/server/lib/incremental-cache/tags-manifest.external.js";
import { codec } from "../codec.js";
import { onNatsShutdown } from "../connection.js";

export interface TagRecord {
  stale?: number;
  expired?: number;
}

export interface TagDurations {
  expire?: number;
}

interface StoredTag extends TagRecord {
  tag: string;
}

const CAS_ATTEMPTS = 8;
const READY_TIMEOUT_MS = 5_000;

export const tagKey = (tag: string): string => Buffer.from(tag, "utf8").toString("base64url");
const tagFromKey = (key: string): string => Buffer.from(key, "base64url").toString("utf8");

export class TagStore {
  private readonly records = new Map<string, TagRecord>();
  private stopped = false;
  private watcher?: { stop(): void | Promise<void> };
  private resolveReady: () => void = () => undefined;
  readonly ready: Promise<void> = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  constructor(
    private readonly kv: KV,
    private readonly mirrorToNext = true,
  ) {}

  static async open(kv: KV, mirrorToNext = true): Promise<TagStore> {
    const store = new TagStore(kv, mirrorToNext);
    const { values } = await kv.status();
    if (values === 0) store.resolveReady();
    setTimeout(() => store.resolveReady(), READY_TIMEOUT_MS).unref();
    void store.watch();
    return store;
  }

  private async watch(): Promise<void> {
    while (!this.stopped) {
      try {
        const watcher = await this.kv.watch({ include: KvWatchInclude.LastValue });
        this.watcher = watcher;
        for await (const entry of watcher) {
          const tag = tagFromKey(entry.key);
          if (entry.operation === "PUT") this.apply(tag, entry.json<StoredTag>());
          else this.remove(tag);
          if (entry.isUpdate) this.resolveReady();
        }
      } catch {
        this.watcher = undefined;
      }
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  private apply(tag: string, record: TagRecord): void {
    const next: TagRecord = {
      ...(record.stale !== undefined && { stale: record.stale }),
      ...(record.expired !== undefined && { expired: record.expired }),
    };
    this.records.set(tag, next);
    if (this.mirrorToNext) tagsManifest.set(tag, { ...next });
  }

  private remove(tag: string): void {
    this.records.delete(tag);
    if (this.mirrorToNext) tagsManifest.delete(tag);
  }

  async update(tags: string[], durations?: TagDurations): Promise<void> {
    await Promise.all([...new Set(tags)].map((tag) => this.updateOne(tag, durations)));
  }

  private async updateOne(tag: string, durations?: TagDurations): Promise<void> {
    const key = tagKey(tag);
    const now = Date.now();
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const current = await this.kv.get(key);
      const existing = current && current.operation === "PUT" ? current.json<StoredTag>() : { tag };
      const next: StoredTag = durations
        ? {
            ...existing,
            tag,
            stale: now,
            ...(durations.expire !== undefined && { expired: now + durations.expire * 1000 }),
          }
        : { ...existing, tag, expired: now };
      try {
        if (current) await this.kv.update(key, codec.encodeJson(next), current.revision);
        else await this.kv.create(key, codec.encodeJson(next));
        this.apply(tag, next);
        return;
      } catch (err) {
        if (attempt === CAS_ATTEMPTS - 1) throw err;
      }
    }
  }

  get(tag: string): TagRecord | undefined {
    return this.records.get(tag);
  }

  isExpired(tags: readonly string[], timestamp: number): boolean {
    const now = Date.now();
    for (const tag of tags) {
      const expired = this.records.get(tag)?.expired;
      if (expired !== undefined && expired <= now && expired > timestamp) return true;
    }
    return false;
  }

  isStale(tags: readonly string[], timestamp: number): boolean {
    for (const tag of tags) {
      const stale = this.records.get(tag)?.stale;
      if (stale !== undefined && stale > timestamp) return true;
    }
    return false;
  }

  maxExpired(tags: readonly string[]): number {
    const now = Date.now();
    let max = 0;
    for (const tag of tags) {
      const expired = this.records.get(tag)?.expired;
      if (expired !== undefined && expired <= now && expired > max) max = expired;
    }
    return max;
  }

  stop(): void {
    this.stopped = true;
    void this.watcher?.stop();
    this.resolveReady();
  }
}

export function registerTagStoreShutdown(store: TagStore): void {
  onNatsShutdown(() => store.stop());
}
