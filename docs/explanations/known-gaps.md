# Known gaps

- Cache invalidation assumes replica clocks are roughly synchronised, because tag timestamps are compared across replicas.
- The cache has a bucket-wide TTL, not a per-key one, and stale tag records are not pruned.
- A `'use cache'` result computed during `next build` can be served from the build output until its key changes.
- `NATS_WORKERS` is all or nothing per process.
- KV operations are atomic per key only. Multi-key commands are not transactions. The [KV reference](../references/kv.md) lists the other differences from Redis.
- Edge Config reads may lag a write by the time the watcher takes to deliver it. Use `consistentRead` when that matters.
- Edge Config writes through `updateEdgeConfigItems` apply in order and are not atomic, unlike the Vercel REST call. The client options `staleIfError`, `disableDevelopmentCache` and `cache` are accepted and ignored. `setTracerProvider` does nothing.
- Vercel cron calls from `vercel.json` never retry, as on Vercel, and use five field schedules in UTC. Details of Vercel cron behavior that this implementation follows from public documentation and could not be checked offline: redirects are not followed, and a status of 400 or above is a failure.
- Cron is at least once. See [cron deduplication](./cron-deduplication.md).
