# Known gaps

- Cache invalidation assumes replica clocks are roughly synchronised, because tag timestamps are compared across replicas.
- The cache has a bucket-wide TTL, not a per-key one, and stale tag records are not pruned.
- A `'use cache'` result computed during `next build` can be served from the build output until its key changes.
- `NATS_WORKERS` is all or nothing per process.
- KV operations are atomic per key only. Multi-key commands are not transactions. The [KV reference](../references/kv.md) lists the other differences from Redis.
- Edge Config reads may lag a write by the time the watcher takes to deliver it. Use `consistentRead` when that matters.
- Edge Config writes through `updateEdgeConfigItems` apply in order and are not atomic, unlike the Vercel REST call. The client options `staleIfError`, `disableDevelopmentCache` and `cache` are accepted and ignored. `setTracerProvider` does nothing.
- Vercel cron calls from `vercel.json` run exactly once per tick across replicas, where Vercel delivery is best effort and can miss or duplicate a run.
- Cron is at least once. See [cron deduplication](./cron-deduplication.md).
- Queue: `receive` by `messageId`, `experimental_concurrencyKey` and v1 structured callbacks throw `BadRequestError`. Coalescing options are accepted and ignored, and `experimental_handoff` behaves like `afterSeconds`. See the [queue reference](../references/queue.md#differences-from-vercel-queues).
- Blob tokens are signed with `BLOB_SECRET` (or `BLOB_READ_WRITE_TOKEN`) and use the prefix `blob_client_`. The `token`, `oidcToken` and `storeId` options are ignored by in-process server calls, and `webhookPublicKey` is ignored by `handleUploadPresigned`.
- Blob `optimizeImage`, `putImage` and `putFromUrl` throw, because there is no image pipeline.
- Blob `get` returns `null` on an access mismatch and ignores `useCache` and `headers`. Client uploads decide public or private through the `x-blob-access` header rather than store settings, and report progress as 0 then 100.
- The blob store, suspension and rate limit errors exist but are rarely thrown.
- Blob upload-completed callbacks are fire and forget with no retries.
