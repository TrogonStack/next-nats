# Cache and Next.js integration

## withNats

`withNats(nextConfig, options)` from `@trogonstack/next-nats/next` returns a Next.js config.

- Adds the NATS packages to `serverExternalPackages` (`NATS_EXTERNAL_PACKAGES`).
- With `cache` set and the platform self-hosted, installs the handlers and sets `cacheMaxMemorySize` to `0`.
- On a self-hosted platform, aliases the Vercel and Upstash specifiers to the subpaths of this package and embeds `vercel.json`.
- On the `vercel` platform, returns the config with only the external packages added: no aliases, no cache handlers and no embedded `vercel.json`.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `platform` | `"vercel"` when `process.env.VERCEL` is set at build time, otherwise `"self-hosted"` | Forces either behavior regardless of the environment |
| `vercelJson` | `"vercel.json"` | Path of the file embedded at build time, relative to the project root. `false` skips embedding |
| `cache` | off | Cache handler options below |

### Import aliases

`VERCEL_IMPORT_ALIASES` holds the mapping, applied to `turbopack.resolveAlias` and to webpack `resolve.alias` for server and browser bundles. Aliases you set yourself in `turbopack.resolveAlias` win.

| Specifier | Resolves to |
| --- | --- |
| `@upstash/redis` | `@trogonstack/next-nats/redis` |
| `@vercel/kv` | `@trogonstack/next-nats/kv` |
| `@upstash/ratelimit` | `@trogonstack/next-nats/ratelimit` |
| `@vercel/blob` | `@trogonstack/next-nats/blob` |
| `@vercel/blob/client` | `@trogonstack/next-nats/blob/client` |
| `@vercel/edge-config` | `@trogonstack/next-nats/edge-config` |
| `@vercel/queue` | `@trogonstack/next-nats/queue` |

### Embedded vercel.json

The value is stored in `env.NEXT_NATS_VERCEL_JSON` and inlined into the server bundles, so the cron registrar and the queue worker read it without touching the filesystem and `output: "standalone"` works without copying the file. When the variable is absent, the runtime reads `vercel.json` from the working directory without tracing it.

`cache` is `true` or an object. Besides the [cache options](./configuration.md#cache) it accepts `useCache`, `remote` and `incremental`, each defaulting to `true`.

| Flag | Installs |
| --- | --- |
| `useCache` | `cacheHandlers.default` for `'use cache'` |
| `remote` | `cacheHandlers.remote`, needs `useCache` |
| `incremental` | `cacheHandler` for ISR and the fetch cache |

`USE_CACHE_HANDLER_PATH` and `INCREMENTAL_HANDLER_PATH` are the resolved handler module paths.

## @trogonstack/next-nats/cache

| Export | Description |
| --- | --- |
| `createUseCacheHandler(options?)`, `NatsUseCacheHandler` | Handler for `'use cache'` |
| `createIncrementalCacheHandler(options?)`, `NatsIncrementalCacheHandler` | Handler for ISR and fetch caching |
| `getBackend(kind, options?)`, `bucketNames(namespace)` | Shared stores per namespace. One KV bucket `<namespace>_cache` holds `use cache` entries (`e.data.` keys), ISR entries (`e.isr.` keys) and tags (`t.` keys). Bodies too large for a message go to the Object Store bucket `<namespace>_large`, created on first use |
| `EntryStore`, `hashKey` | Entry store with LRU front, watcher and Object Store spill |
| `TagStore`, `tagKey` | Tag timestamps mirrored from a KV bucket |
| `resolveCacheOptions`, `cacheOptionsToEnv`, `CACHE_ENV` | Option resolution |
| `pack`, `unpack` | Serialization of cache values |

## Behaviour summary

- Entry keys are SHA-256 hashes of the cache key.
- A body that does not fit in a NATS message is stored in the Object Store and the KV entry points to it.
- Tag updates are compare-and-set on the tag record, retried a bounded number of times.
