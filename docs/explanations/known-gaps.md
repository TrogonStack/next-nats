# Known gaps

- Cache invalidation assumes replica clocks are roughly synchronised, because tag timestamps are compared across replicas.
- The cache has a bucket-wide TTL, not a per-key one, and stale tag records are not pruned.
- A `'use cache'` result computed during `next build` can be served from the build output until its key changes.
- `NATS_WORKERS` is all or nothing per process.
- Single-key KV operations are atomic. `multi()` and multi-key commands run as one JetStream atomic batch (nats-server 2.12 or later) and throw an `UpstashError` when the bucket does not allow atomic batches, instead of running non-atomically. Single-key commands and `pipeline()` keep working there. Every key a transaction reads and does not write is validated at commit through an extra tombstone message in the batch, so a changed read key aborts and retries the transaction. The batch is limited to 1000 messages, counting written and read keys, and the extra messages go to a reserved subject that `keys` and `scan` never list. A transaction that ends up writing nothing is not validated against concurrent writers. Scripting is unavailable. The [Redis reference](../references/redis.md) lists the other differences from Redis.
- Edge Config reads may lag a write by the time the watcher takes to deliver it. Use `consistentRead` when that matters.
- Edge Config writes through `updateEdgeConfigItems` are validated against one read of every key and committed as one atomic batch with the expected revision per key. A concurrent writer makes the call re-read, re-validate and retry up to a bounded number of attempts, so a concurrent change to an updated item no longer fails with `CONCURRENT_UPDATE` unless the retries run out, and the batch is limited to 1000 keys. Keys containing `:` are rejected on write, and there is no token authentication. The default client has a fallback bucket where the real one throws when `EDGE_CONFIG` is unset. The client options `staleIfError`, `disableDevelopmentCache` and `cache` are accepted and ignored. `setTracerProvider` does nothing.
- The `edge` entry publishes, reads and writes existing KV buckets, makes requests and streams core subjects. It has no JetStream consumers, bucket provisioning, KV watch, lifecycle events or health state, and it needs WebSocket access to the server. Edge KV reads and writes only string values of the Redis compatible `kv` records. Credential files and TLS file options are unavailable in the Edge runtime. Next 16 deprecates `middleware.ts` in favor of `proxy.ts`, which runs on Node.js, so Edge use under `cacheComponents` depends on the deprecated file convention.
- Vercel cron calls from `vercel.json` run exactly once per tick across replicas, where Vercel delivery is best effort and can miss or duplicate a run.
- Cron is at least once. See [cron deduplication](./cron-deduplication.md).
- Queue: `receive` by `messageId`, `experimental_concurrencyKey` and v1 structured callbacks throw `BadRequestError`. Coalescing options are accepted and ignored, and `experimental_handoff` behaves like `afterSeconds`. See the [queue reference](../references/queue.md#differences-from-vercel-queues).
- Blob tokens are signed with `BLOB_SECRET` (or `BLOB_READ_WRITE_TOKEN`) and use the prefix `blob_client_`. The `token`, `oidcToken` and `storeId` options are ignored by in-process server calls, and `webhookPublicKey` is ignored by `handleUploadPresigned`.
- Blob `optimizeImage`, `putImage` and `putFromUrl` throw, because there is no image pipeline.
- Blob `get` returns `null` on an access mismatch and ignores `useCache` and `headers`. Client uploads decide public or private through the `x-blob-access` header rather than store settings, and report single-request progress as a start event and a finish event, without in-flight events.
- The blob store, suspension and rate limit errors exist but are rarely thrown.
- Blob upload-completed callbacks are fire and forget with no retries.
- Vercel cron accepts at most one hundred jobs, five field UTC expressions without day or month names, and no job that sets both day of month and day of week. `registerVercelCrons` rejects the same inputs. Hobby plan limits (once per day, per-hour precision) are not enforced.
- Queue message delivery counts for delayed messages are kept in memory and restart from the stored count after a process restart.
- Agents cannot verify who sent a prompt. `getAgents()` builds the calling client without sender identity, so prompts sent through this package carry no signed `Agent-Sender` header. `defineAgent` does not expose the host options `identity`, `minSenderTrust`, `acceptSender` or `operatorAttested`, so a hosted agent advertises `min_sender_trust` as `any`, cannot refuse unsigned or unverified senders and cannot register or sign its own identity. `response.sender` can only be verified when a caller outside this package signs its requests, and the handler has no way to require that. The `agent` and `owner` fields are labels that any process allowed to publish to the prompt subject can claim. Restrict who may publish to `agents.prompt.>` with NATS permissions, or check the caller in an interceptor on information you control.

- Right after the NATS server restarts, the app reports ready as soon as its connection is back, while the first JetStream calls can still time out for a few seconds. Cache invalidation and enqueue calls made in that window fail with a 500 and succeed on retry.
- A `next build --webpack` type-checks route handlers more strictly than Turbopack. Handlers must declare a plain `(request: Request)` signature instead of spreading the parameters of a wrapped handler.

## Parity assumptions

The differential suites under `packages/next-nats/tests/vitest/differential` run the real SDK against a local fake of the Vercel service and this package against NATS. The fakes decide the following where the SDK source and the Vercel documentation are silent.

- Edge Config: the status code of a rejected REST write is 400, and deleting a missing item is an error. The digest is opaque, so only its properties are compared.
- Queue: a duplicate idempotent send receives a fresh message id and is dropped. A batch send answers 200 with results in request order. The `ce-id` and `ce-source` formats of pushed callbacks are invented, because the SDK never reads them in v2beta binary mode. A failed callback keeps the message invisible for `retryAfterSeconds`. A new consumer group reads from the beginning, which the documentation confirms only for poll mode.
- Cron: the suite checks the documented behavior (GET, `vercel-cron/1.0`, `x-vercel-cron-schedule`, `Authorization: Bearer $CRON_SECRET`, no retries, no redirects, UTC). The `x-vercel-cron-schedule` header is documented on the cron pages. No Vercel cron fake exists, so these are checked against the documentation rather than a running service.

### Blob

The blob differential suite runs the real `@vercel/blob` against a local fake of the Vercel Blob service (`packages/next-nats/tests/support/fakes/vercel-blob.ts`). The SDK source does not reveal how the service behaves in these places, so the fake makes an assumption at each and the suite compares those results by class only or avoids them. Each one is marked `ASSUMPTION` in the fake.

- The random suffix is 30 mixed-case alphanumerics.
- The etag is a quoted hash of the content.
- A URL maps to a pathname by its path only, and a token minted for another store is rejected as a missing store.
- The content disposition filename is the last path segment, inline unless downloading.
- The default cache max age is 2592000 seconds, rendered as `public, max-age=<seconds>`.
- `addRandomSuffix` and `allowOverwrite` default to false, and a duplicate pathname is a `bad_request` that the SDK surfaces as `BlobError`.
- Content type precedence is the `x-content-type` header, then the extension, then `application/octet-stream`. The request Content-Type is ignored.
- A conditional write against a missing blob fails the precondition.
- The upload completed callback is fired after the upload response.
- `list` defaults to a limit of 1000, orders lexicographically, uses an opaque cursor and folds with the `/` delimiter.
- `copy` keeps the source content type unless one is given, deleting a missing blob succeeds silently, and `createFolder` is idempotent.
- An unknown multipart upload id is `not_found`, part etags are opaque, the 5 MiB minimum part size is not enforced, and parts are joined in ascending part number.
- Private blobs are readable only with the read-write token.
- Messages for a pathname mismatch, a disallowed content type, an oversized upload and a tampered token are compared by error class only.

#### Blob intentional deviations

- `put` with a trailing slash pathname is rejected here and passed through by the real SDK.
- Without `VERCEL_BLOB_CALLBACK_URL`, the upload completed callback URL is derived from the request. The real SDK sends none off Vercel.
- `get` returns the pathname undecoded, mirroring the real SDK.
- Client token wire format differs: `blob_client_` prefix and the `x-blob-signature` header here, `vercel_blob_client_<storeId>_` and `x-vercel-signature` there.
- Out of scope for parity: `presign`, `issueSignedToken`, `putImage`, `putFromUrl` and the real SDK's missing token error, because the configured secret is always used here.
- The real client mishandles a bare `Uint8Array` body in multipart and progress uploads. The suite uses `Buffer` bodies there.

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
- The end-to-end suite expects Vercel cron requests to carry `user-agent: vercel-cron/1.0`, `x-vercel-cron-schedule` and `authorization: Bearer <CRON_SECRET>`, because that is what the library sends. It is not checked against Vercel itself.
- A build with `VERCEL=1` is expected to bundle the real `@vercel/*` and `@upstash/*` packages and to install no NATS cache handler. The suite asserts that the NATS implementation is absent only for `@upstash/ratelimit`, because the demo also imports some `@trogonstack/next-nats` subpaths directly (for example the health routes and Edge Config updates), so those markers appear in any build.
