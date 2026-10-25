# Known gaps

- Cache invalidation assumes replica clocks are roughly synchronised, because tag timestamps are compared across replicas.
- The cache has a bucket-wide TTL, not a per-key one, and stale tag records are not pruned.
- A `'use cache'` result computed during `next build` can be served from the build output until its key changes.
- `NATS_WORKERS` is all or nothing per process.
- Single-key KV operations are atomic, and `multi()` and multi-key commands are atomic when the server supports JetStream atomic batch publish (nats-server 2.12 or later), limited to 1000 keys. Scripting is unavailable. The [Redis reference](../references/redis.md) lists the other differences from Redis.
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

## Parity assumptions

### Redis, KV and ratelimit

The differential suites run the real `@upstash/redis`, `@vercel/kv` and `@upstash/ratelimit` against Redis 8.2 behind the `hiett/serverless-redis-http` proxy. These are the places where the comparison depends on a choice, or where we deliberately differ.

- Redis 8 is used because `hgetdel` needs it. The proxy is not Upstash's service, so server-only features (such as the `allow-key-locking` script flag) are stripped for the real client.
- `ping(message)` in the real SDK sends only the first character of the message. Ours reproduces that.
- When a pipeline or auto-pipelined command fails, the real SDK sometimes throws a `TypeError` ("reading 'every'", "'0'" or "'length'") instead of surfacing the server error. Ours returns the server error. The comparison accepts the `TypeError` only when ours carries a server error.
- The real SDK appends `, command was: [...]` to errors from direct commands. Ours does not, and the comparison strips the suffix.
- The `Command failed: ` error prefix comes from SDK auto-pipelining and is reproduced when `enableAutoPipelining` is not `false`.
- Pipeline error messages use the wire command name, so `copy` is reported as `COPY`.
- With `automaticDeserialization: false`, floats are formatted with JavaScript `String(n)`.
- The proxy crashes on some `multi` executions with a 500. Those cases are skipped, not compared.
- The Redis surface test keeps an explicit list of commands we do not implement (search, JSON, vector, functions, geo, bit operations, streams, hash field expiry, `lmpop`, HyperLogLog, pub/sub). Script commands (`eval` and its relatives) throw `UnsupportedCommandError`.
- `@vercel/kv` throws a missing environment variable error the first time the default `kv` client is used. Ours is created eagerly and needs no environment.
- Ratelimit multi-region and `enableProtection` are unsupported and throw `UnsupportedCommandError`.
- Ratelimit stores one record per identifier where the real library uses several keys. Only the limiter results are comparable, and they match.
- The real `resetUsedTokens` deletes with a `SCAN` of `identifier:*`, which can remove keys of other identifiers sharing the prefix. Ours removes one identifier.
- Ratelimit scenarios fake `Date` only. Key expiry on the real Redis is emulated by deleting keys the model considers expired, with 1 s granularity and a 1.5 s slack.
