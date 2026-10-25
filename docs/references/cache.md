# Cache and Next.js integration

## withNats

`withNats(nextConfig, options)` from `next-nats/next` returns a Next.js config.

- Adds the NATS packages to `serverExternalPackages` (`NATS_EXTERNAL_PACKAGES`).
- With `cache` set, installs the handlers and sets `cacheMaxMemorySize` to `0`.

`cache` is `true` or an object. Besides the [cache options](./configuration.md#cache) it accepts `useCache`, `remote` and `incremental`, each defaulting to `true`.

| Flag | Installs |
| --- | --- |
| `useCache` | `cacheHandlers.default` for `'use cache'` |
| `remote` | `cacheHandlers.remote`, needs `useCache` |
| `incremental` | `cacheHandler` for ISR and the fetch cache |

`USE_CACHE_HANDLER_PATH` and `INCREMENTAL_HANDLER_PATH` are the resolved handler module paths.

## next-nats/cache

| Export | Description |
| --- | --- |
| `createUseCacheHandler(options?)`, `NatsUseCacheHandler` | Handler for `'use cache'` |
| `createIncrementalCacheHandler(options?)`, `NatsIncrementalCacheHandler` | Handler for ISR and fetch caching |
| `getBackend(kind, options?)`, `bucketNames(namespace)` | Shared stores per namespace. Buckets are `<namespace>_data`, `<namespace>_isr`, `<namespace>_tags` and `<namespace>_large` |
| `EntryStore`, `hashKey` | Entry store with LRU front, watcher and Object Store spill |
| `TagStore`, `tagKey` | Tag timestamps mirrored from a KV bucket |
| `resolveCacheOptions`, `cacheOptionsToEnv`, `CACHE_ENV` | Option resolution |
| `pack`, `unpack` | Serialization of cache values |

## Behaviour summary

- Entry keys are SHA-256 hashes of the cache key.
- A body that does not fit in a NATS message is stored in the Object Store and the KV entry points to it.
- Tag updates are compare-and-set on the tag record, retried a bounded number of times.
