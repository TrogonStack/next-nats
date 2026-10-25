import { createHash, randomUUID } from "node:crypto";
import type { KV } from "@nats-io/kv";
import { KvWatchInclude } from "@nats-io/kv";
import { nanos } from "@nats-io/nats-core";
import type { ObjectStore } from "@nats-io/obj";
import { getNats, getObjm, onNatsShutdown, onNatsStatus, openKv } from "../connection.js";
import { frame, unframe } from "./pack.js";
import { ByteLru } from "./lru.js";

export interface StoredEntry<M> {
  meta: M;
  body: Uint8Array;
  revision: number;
}

interface Envelope<M> {
  v: 1;
  key: string;
  meta: M;
  object?: string;
}

export interface EntryStoreOptions {
  bucket: string;
  objectBucket: string;
  ttl: number;
  lruBytes: number;
  inlineLimit?: number;
  replicas: number;
}

const PAYLOAD_MARGIN = 16 * 1024;
const SEEN_LIMIT = 50_000;
const OBJECT_TTL_MARGIN_MS = 60 * 60 * 1000;

export const hashKey = (cacheKey: string): string => createHash("sha256").update(cacheKey).digest("base64url");

export class EntryStore<M> {
  private readonly lru: ByteLru<StoredEntry<M>>;
  private readonly seen = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<StoredEntry<M> | undefined>>();
  private objects?: Promise<ObjectStore>;
  private stopped = false;
  private watcher?: { stop(): void | Promise<void> };
  private offStatus?: () => void;

  private constructor(
    private readonly kv: KV,
    private readonly options: EntryStoreOptions,
    private readonly inlineLimit: number,
  ) {
    this.lru = new ByteLru(options.lruBytes);
  }

  static async open<M>(options: EntryStoreOptions): Promise<EntryStore<M>> {
    const kv = await openKv(options.bucket, { ttl: options.ttl, replicas: options.replicas, history: 1 });
    const { nc } = await getNats();
    const maxPayload = nc.info?.max_payload ?? 1024 * 1024;
    const inlineLimit = options.inlineLimit ?? Math.max(1024, maxPayload - PAYLOAD_MARGIN);
    const store = new EntryStore<M>(kv, options, inlineLimit);
    store.offStatus = onNatsStatus((event) => {
      if (event.type === "reconnect") store.clearFront();
    });
    void store.watch();
    return store;
  }

  private openObjects(): Promise<ObjectStore> {
    this.objects ??= getObjm()
      .then((objm) =>
        objm.create(this.options.objectBucket, {
          ...(this.options.ttl > 0 && { ttl: nanos(this.options.ttl + OBJECT_TTL_MARGIN_MS) }),
          replicas: this.options.replicas,
        }),
      )
      .catch((err) => {
        this.objects = undefined;
        throw err;
      });
    return this.objects;
  }

  private async watch(): Promise<void> {
    while (!this.stopped) {
      try {
        const watcher = await this.kv.watch({ include: KvWatchInclude.UpdatesOnly, headers_only: true });
        this.watcher = watcher;
        for await (const entry of watcher) this.invalidate(entry.key, entry.revision, entry.operation !== "PUT");
      } catch {
        this.watcher = undefined;
      }
      if (this.stopped) return;
      this.clearFront();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  private invalidate(hashed: string, revision: number, removed: boolean): void {
    if (this.seen.size >= SEEN_LIMIT) this.clearFront();
    this.seen.set(hashed, Math.max(this.seen.get(hashed) ?? 0, revision));
    const cached = this.lru.peek(hashed);
    if (cached && (removed || cached.revision < revision)) this.lru.delete(hashed);
  }

  clearFront(): void {
    this.lru.clear();
    this.seen.clear();
  }

  get frontSize(): number {
    return this.lru.size;
  }

  peekFront(cacheKey: string): StoredEntry<M> | undefined {
    return this.lru.peek(hashKey(cacheKey));
  }

  get(cacheKey: string): Promise<StoredEntry<M> | undefined> {
    const hashed = hashKey(cacheKey);
    const cached = this.lru.get(hashed);
    if (cached) return Promise.resolve(cached);
    let pending = this.inflight.get(hashed);
    if (!pending) {
      pending = this.load(cacheKey, hashed).finally(() => this.inflight.delete(hashed));
      this.inflight.set(hashed, pending);
    }
    return pending;
  }

  private async load(cacheKey: string, hashed: string): Promise<StoredEntry<M> | undefined> {
    const entry = await this.kv.get(hashed);
    if (!entry || entry.operation !== "PUT") return undefined;
    const { header, body } = unframe<Envelope<M>>(entry.value);
    if (header.key !== cacheKey) return undefined;
    let payload = body;
    if (header.object) {
      const blob = await (await this.openObjects()).getBlob(header.object);
      if (!blob) return undefined;
      payload = blob;
    }
    const stored: StoredEntry<M> = { meta: header.meta, body: payload, revision: entry.revision };
    if (entry.revision >= (this.seen.get(hashed) ?? 0)) this.lru.set(hashed, stored, payload.byteLength + cacheKey.length);
    return stored;
  }

  async set(cacheKey: string, meta: M, body: Uint8Array): Promise<void> {
    const hashed = hashKey(cacheKey);
    const previous = await this.kv.get(hashed).catch(() => null);
    let object: string | undefined;
    let value: Uint8Array;
    const envelopeOverhead = cacheKey.length + 1024;
    if (body.byteLength + envelopeOverhead + JSON.stringify(meta).length <= this.inlineLimit) {
      value = frame({ v: 1, key: cacheKey, meta } satisfies Envelope<M>, body);
    } else {
      object = `${hashed}.${randomUUID()}`;
      await (await this.openObjects()).putBlob({ name: object }, body);
      value = frame({ v: 1, key: cacheKey, meta, object } satisfies Envelope<M>, new Uint8Array(0));
    }
    let revision: number;
    try {
      revision = await this.kv.put(hashed, value);
    } catch (err) {
      if (object) void this.dropObject(object);
      throw err;
    }
    this.invalidate(hashed, revision, false);
    this.lru.set(hashed, { meta, body, revision }, body.byteLength + cacheKey.length);
    if (previous && previous.operation === "PUT") void this.dropPrevious(previous.value);
  }

  async delete(cacheKey: string): Promise<void> {
    const hashed = hashKey(cacheKey);
    const previous = await this.kv.get(hashed).catch(() => null);
    this.lru.delete(hashed);
    await this.kv.delete(hashed);
    if (previous && previous.operation === "PUT") void this.dropPrevious(previous.value);
  }

  private async dropPrevious(value: Uint8Array): Promise<void> {
    try {
      const { header } = unframe<Envelope<M>>(value);
      if (header.object) await this.dropObject(header.object);
    } catch {
      return;
    }
  }

  private async dropObject(name: string): Promise<void> {
    try {
      await (await this.openObjects()).delete(name);
    } catch {
      return;
    }
  }

  stop(): void {
    this.stopped = true;
    this.offStatus?.();
    void this.watcher?.stop();
  }
}

export function registerStoreShutdown(store: { stop(): void }): void {
  onNatsShutdown(() => store.stop());
}
