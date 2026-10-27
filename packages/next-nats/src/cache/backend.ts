import { openKv } from "../connection.js";
import { resolveCacheOptions, type CacheOptions, type ResolvedCacheOptions } from "./options.js";
import { EntryStore, KEY_TTL_MARGIN_MS, registerStoreShutdown } from "./store.js";
import { TagStore, registerTagStoreShutdown } from "./tags.js";

export type CacheStoreKind = "data" | "isr";

export interface CacheBackend<M> {
  options: ResolvedCacheOptions;
  tags: TagStore;
  entries: EntryStore<M>;
  stop(): void;
}

export interface BackendOptions extends CacheOptions {
  shared?: boolean;
}

const REGISTRY_KEY = Symbol.for("next-nats.cache.backends");
const TAGS_KEY = Symbol.for("next-nats.cache.tags");

function tagRegistry(): Map<string, Promise<TagStore>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<TagStore>> | undefined>;
  return (g[TAGS_KEY] ??= new Map());
}

function registry(): Map<string, Promise<CacheBackend<never>>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<CacheBackend<never>>> | undefined>;
  return (g[REGISTRY_KEY] ??= new Map());
}

export const bucketNames = (namespace: string) => ({
  cache: `${namespace}_cache`,
  objects: `${namespace}_large`,
});

const ENTRY_PREFIX: Record<CacheStoreKind, string> = { data: "e.data.", isr: "e.isr." };

const bucketOptions = (options: ResolvedCacheOptions) => ({
  ttl: options.ttl > 0 ? options.ttl + KEY_TTL_MARGIN_MS : 0,
  replicas: options.replicas,
  history: 1,
});

async function openTags(options: ResolvedCacheOptions): Promise<TagStore> {
  const kv = await openKv(bucketNames(options.namespace).cache, bucketOptions(options));
  const tags = await TagStore.open(kv);
  registerTagStoreShutdown(tags);
  return tags;
}

function sharedTags(options: ResolvedCacheOptions): Promise<TagStore> {
  const reg = tagRegistry();
  let tags = reg.get(options.namespace);
  if (!tags) {
    tags = openTags(options);
    reg.set(options.namespace, tags);
    tags.catch(() => reg.delete(options.namespace));
  }
  return tags;
}

async function openBackend<M>(
  kind: CacheStoreKind,
  options: ResolvedCacheOptions,
  shared: boolean,
): Promise<CacheBackend<M>> {
  const names = bucketNames(options.namespace);
  const tags = await (shared ? sharedTags(options) : openTags(options));
  const entries = await EntryStore.open<M>({
    bucket: names.cache,
    prefix: ENTRY_PREFIX[kind],
    bucketOptions: bucketOptions(options),
    objectBucket: names.objects,
    ttl: options.ttl,
    lruBytes: options.lruBytes,
    inlineLimit: options.inlineLimit,
    replicas: options.replicas,
  });
  registerStoreShutdown(entries);
  return {
    options,
    tags,
    entries,
    stop() {
      if (!shared) tags.stop();
      entries.stop();
    },
  };
}

export function getBackend<M>(kind: CacheStoreKind, input: BackendOptions = {}): Promise<CacheBackend<M>> {
  const { shared = true, ...rest } = input;
  const options = resolveCacheOptions(rest);
  if (!shared) return openBackend<M>(kind, options, shared);
  const key = `${kind}:${options.namespace}`;
  const reg = registry();
  let backend = reg.get(key);
  if (!backend) {
    backend = openBackend<M>(kind, options, shared) as Promise<CacheBackend<never>>;
    reg.set(key, backend);
    backend.catch(() => reg.delete(key));
  }
  return backend as unknown as Promise<CacheBackend<M>>;
}
