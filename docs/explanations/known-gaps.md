# Known gaps

- Cache invalidation assumes replica clocks are roughly synchronised, because tag timestamps are compared across replicas.
- The cache has a bucket-wide TTL, not a per-key one, and stale tag records are not pruned.
- A `'use cache'` result computed during `next build` can be served from the build output until its key changes.
- `NATS_WORKERS` is all or nothing per process.
- Single-key KV operations are atomic, and `multi()` and multi-key commands are atomic when the server supports JetStream atomic batch publish (nats-server 2.12 or later), limited to 1000 keys. Scripting is unavailable. The [Redis reference](../references/redis.md) lists the other differences from Redis.
- Edge Config reads may lag a write by the time the watcher takes to deliver it. Use `consistentRead` when that matters.
- Edge Config writes through `updateEdgeConfigItems` are checked up front and applied in order, so they are atomic except against concurrent writers. Keys containing `:` are rejected on write, and there is no token authentication. The default client has a fallback bucket where the real one throws when `EDGE_CONFIG` is unset. The client options `staleIfError`, `disableDevelopmentCache` and `cache` are accepted and ignored. `setTracerProvider` does nothing.
- Vercel cron calls from `vercel.json` run exactly once per tick across replicas, where Vercel delivery is best effort and can miss or duplicate a run.
- Cron is at least once. See [cron deduplication](./cron-deduplication.md).
- Queue: `receive` by `messageId`, `experimental_concurrencyKey` and v1 structured callbacks throw `BadRequestError`. Coalescing options are accepted and ignored, and `experimental_handoff` behaves like `afterSeconds`. See the [queue reference](../references/queue.md#differences-from-vercel-queues).
- Blob tokens are signed with `BLOB_SECRET` (or `BLOB_READ_WRITE_TOKEN`) and use the prefix `blob_client_`. The `token`, `oidcToken` and `storeId` options are ignored by in-process server calls, and `webhookPublicKey` is ignored by `handleUploadPresigned`.
- Blob `optimizeImage`, `putImage` and `putFromUrl` throw, because there is no image pipeline.
- Blob `get` returns `null` on an access mismatch and ignores `useCache` and `headers`. Client uploads decide public or private through the `x-blob-access` header rather than store settings, and report progress as 0 then 100.
- The blob store, suspension and rate limit errors exist but are rarely thrown.
- Blob upload-completed callbacks are fire and forget with no retries.
- Vercel cron accepts at most one hundred jobs, five field UTC expressions without day or month names, and no job that sets both day of month and day of week. `registerVercelCrons` rejects the same inputs. Hobby plan limits (once per day, per-hour precision) are not enforced.
- Queue message delivery counts for delayed messages are kept in memory and restart from the stored count after a process restart.

## Parity assumptions

The differential suites under `packages/next-nats/tests/vitest/differential` run the real SDK against a local fake of the Vercel service and this package against NATS. The fakes decide the following where the SDK source and the Vercel documentation are silent.

- Edge Config: the status code of a rejected REST write is 400, and deleting a missing item is an error. The digest is opaque, so only its properties are compared.
- Queue: a duplicate idempotent send receives a fresh message id and is dropped. A batch send answers 200 with results in request order. The `ce-id` and `ce-source` formats of pushed callbacks are invented, because the SDK never reads them in v2beta binary mode. A failed callback keeps the message invisible for `retryAfterSeconds`. A new consumer group reads from the beginning, which the documentation confirms only for poll mode.
- Cron: the suite checks the documented behavior (GET, `vercel-cron/1.0`, `x-vercel-cron-schedule`, `Authorization: Bearer $CRON_SECRET`, no retries, no redirects, UTC). The `x-vercel-cron-schedule` header is documented on the cron pages. No Vercel cron fake exists, so these are checked against the documentation rather than a running service.
