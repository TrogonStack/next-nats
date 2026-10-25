# Known gaps

- Cache invalidation assumes replica clocks are roughly synchronised, because tag timestamps are compared across replicas.
- The cache has a bucket-wide TTL, not a per-key one, and stale tag records are not pruned.
- A `'use cache'` result computed during `next build` can be served from the build output until its key changes.
- `NATS_WORKERS` is all or nothing per process.
- KV operations are atomic per key only, `multi()` is not a transaction, and scripting is unavailable. The [Redis reference](../references/redis.md) lists the other differences from Redis.
- Edge Config reads may lag a write by the time the watcher takes to deliver it. Use `consistentRead` when that matters.
- Cron is at least once. See [cron deduplication](./cron-deduplication.md).
