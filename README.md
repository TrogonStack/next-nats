# next-nats

Vercel platform primitives for self-hosted Next.js, running on NATS and JetStream. One `nats-server` replaces the managed KV, Blob, Queues, Edge Config, cache and cron services, and every Next.js replica shares the same state.

## Quick start

Start NATS with JetStream enabled:

```sh
docker compose up -d
```

Install, build the library and run the demo against it:

```sh
pnpm install
pnpm build
export NATS_SERVERS=nats://localhost:4222
cd examples/demo
NATS_WORKERS=true pnpm start
```

`NATS_SERVERS` is a comma separated list of server URLs. `NATS_WORKERS=true` starts the long-running consumers (queue handlers, cron) in that process. Leave it off on replicas that should only serve requests.

Run the checks from the repository root:

```sh
pnpm typecheck
pnpm test
examples/demo/scripts/verify-cache.sh
```

The tests and the script need a reachable NATS server. The script starts two `next start` processes against it and proves that an invalidation on one replica is seen by the other.

## Wire it into Next.js

```ts
// next.config.ts
import { withNats } from "next-nats/next";

export default withNats({ cacheComponents: true }, { cache: true });
```

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNats } = await import("next-nats/instrumentation");
    await registerNats({ setup: () => import("./services/nats/consumers") });
  }
}
```

## Primitives

| Vercel primitive | Import | NATS feature underneath |
| --- | --- | --- |
| KV (`@vercel/kv`) | `next-nats/kv` | KV bucket, compare-and-set on revisions, per-message TTL |
| Blob (`@vercel/blob`) | `next-nats/blob` | Object Store, signed upload tokens, route handler |
| Queues | `next-nats/queue` | JetStream stream with pull consumers, redelivery, dead letters |
| Edge Config | `next-nats/edge-config` | KV bucket with a watcher feeding an in-process mirror |
| Data Cache and `use cache` | `next-nats/cache`, wired by `next-nats/next` | KV buckets for entries and tags, Object Store for large bodies, watches for coherency |
| Rate limiting | `next-nats/ratelimit` | KV bucket with atomic window counters |
| Realtime and streaming | `next-nats/realtime` | Core subscriptions and ordered JetStream consumers relayed over SSE |
| Services and RPC | `next-nats/services` | NATS micro services, request/reply, scatter-gather, discovery |
| Cron Jobs | `next-nats/cron` | JetStream schedule ticks claimed by exactly one replica |
| Health | `next-nats/health` | Connection and JetStream status route |

Per-module notes:

- [KV](packages/next-nats/src/kv/README.md)

## How the cache works

Two handlers are installed: one for `'use cache'` (`cacheHandlers`) and one for ISR and fetch caching (`cacheHandler`). Entries live in KV, with bodies too large for a NATS message moved to the Object Store. Tag state lives in its own bucket. Each process keeps a small in-memory front cache and watches the buckets, so a tag update or a rewritten entry on one replica evicts the stale copy on every other replica within milliseconds.

Options go through `withNats(config, { cache: { namespace, ttl, lruBytes, inlineLimit, replicas } })`, which hands them to the handlers as `NEXT_NATS_CACHE_*` environment variables.

## Rules for apps using `cacheComponents`

- Route segment config such as `export const dynamic` is rejected. Remove it.
- Request-time NATS work in a page must run under `await connection()` inside a `<Suspense>` boundary, or inside a `'use cache'` function.
- Route handlers that touch NATS call `await connection()` first.

## Known gaps

- Cache invalidation assumes replica clocks are roughly synchronised, because tag timestamps are compared across replicas.
- The cache has a bucket-wide TTL, not a per-key one, and stale tag records are not pruned.
- A `'use cache'` result computed during `next build` can be served from the build output until its key changes.
- `NATS_WORKERS` is all or nothing per process.
