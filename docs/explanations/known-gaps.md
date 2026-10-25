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
- Blob `get` returns `null` on an access mismatch and ignores `useCache` and `headers`. Client uploads decide public or private through the `x-blob-access` header rather than store settings, and report single-request progress as a start event and a finish event, without in-flight events.
- The blob store, suspension and rate limit errors exist but are rarely thrown.
- Blob upload-completed callbacks are fire and forget with no retries.

## Parity assumptions

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

### Intentional deviations

- `put` with a trailing slash pathname is rejected here and passed through by the real SDK.
- Without `VERCEL_BLOB_CALLBACK_URL`, the upload completed callback URL is derived from the request. The real SDK sends none off Vercel.
- `get` returns the pathname undecoded, mirroring the real SDK.
- Client token wire format differs: `blob_client_` prefix and the `x-blob-signature` header here, `vercel_blob_client_<storeId>_` and `x-vercel-signature` there.
- Out of scope for parity: `presign`, `issueSignedToken`, `putImage`, `putFromUrl` and the real SDK's missing token error, because the configured secret is always used here.
- The real client mishandles a bare `Uint8Array` body in multipart and progress uploads. The suite uses `Buffer` bodies there.
