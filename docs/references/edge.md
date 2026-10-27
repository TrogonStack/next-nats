# Edge

`@trogonstack/next-nats/edge` publishes, reads KV, makes requests and subscribes from the Next.js Edge runtime and middleware. It connects over WebSocket with `wsconnect` from `@nats-io/nats-core` and imports no `node:` module, no `@nats-io/transport-node` and no `server-only`.

| Export | Purpose |
| --- | --- |
| `corePublish(subject, payload, opts?)` | Core publish, flushed before it resolves |
| `jsPublish(subject, payload, opts?)` | JetStream publish returning a `PubAck`, with `msgId`, `timeout` and `retry` |
| `edgeKv(bucket)` | Handle on an existing bucket with `get`, `put`, `delete` and `keys` |
| `edgeRequest(subject, payload?, opts?)` | Request and reply returning an `EdgeReply`, with `timeout`, `headers` and trace options |
| `EdgeRequestError` | Thrown for no responders, timeout and service errors |
| `edgeSubscribe(subject, opts?)` | `ReadableStream` of `EdgeMessage`, closed and unsubscribed on `signal` abort |
| `edgeSseFromSubject(request, subject, opts?)` | SSE `Response` for a core subject, closed on request abort |
| `getEdgeNats()` | The cached `{ nc, js }` pair |
| `configureEdgeNats(input?)` | Sets config before the first connection |
| `getEdgeNatsConfig()` | The resolved `EdgeNatsConfig` |
| `closeEdgeNats()` | Drains and drops the cached connection |
| `edgeNatsConfig(input?)` | Pure config from `input` and defaults, never reads the environment |
| `edgeNatsConfigFromEnv(env?)` | Config from the environment variables below |
| `TraceContext`, `Secret`, `resolveTrace` | Same classes and helper as the main entry |

Payload encoding, headers, trace options (`trace`, `traceparent`, `tracestate`) and retry behaviour match [Core](./core.md#publishing).

## KV

`edgeKv(bucket)` validates the bucket name like the Node entry and opens the bucket on first use, caching the handle. It never creates a bucket: a missing one fails with `BUCKET_NOT_FOUND` (`NOT_FOUND`, internal visibility). The handle is a thin view over `@nats-io/kv`.

| Method | Behaviour |
| --- | --- |
| `get(key)` | An `EdgeKvEntry` with `bucket`, `key`, `revision`, `value` and `expiresAt` when the key expires, or `undefined` for a missing, deleted or expired key. `value` is deserialized like the Node `kv` entry |
| `put(key, value, { expectedRevision, ttlSeconds }?)` | Serializes like `kv.set` and returns the revision. With `expectedRevision` it is a compare and set that rejects on mismatch. `ttlSeconds` sets the expiry the Node entry honours |
| `delete(key)` | Writes a delete marker |
| `keys(match?)` | Live keys decoded like the Node entry, sorted, optionally filtered by a Redis style glob. Expired keys that have not been removed yet are still listed |

Records and key encoding come from the same modules as the Node `kv` entry, so both runtimes share one format. A key holding a record other than a string fails with `WRONG_TYPE` (`FAILED_PRECONDITION`, internal visibility). `resetEdgeKvHandles()` drops the cached handles, which tests use after closing the connection.

## Request and reply

`edgeRequest` encodes the payload like a publish, waits for one reply (`timeout` defaults to 5 seconds) and returns an `EdgeReply` with `subject`, `data`, `headers`, `json()` and `string()`. `EdgeRequestError.kind` is `timeout`, `unavailable` for no responders, or `service` when the reply carries `Nats-Service-Error-Code`. `status` holds the HTTP style code and `subject` the target.

## Subscriptions

`edgeSubscribe` and `edgeSseFromSubject` use core subscriptions, optionally in a queue group with `queue`. Messages carry `subject`, `data` (JSON decoded when possible), `payload` and `headers`. `edgeSseFromSubject` accepts the SSE options of [Realtime](./realtime.md) (`heartbeat`, `retry`, `maxBuffered`, `headers`) plus `event`, `filter` and `transform`. Delivery is at most once and there is no replay, because a subscription lives only as long as the request. JetStream consumers are not offered in the Edge runtime.

## Configuration

Config comes from the environment through `edgeNatsConfigFromEnv`, which is the default when nothing was configured, or from `configureEdgeNats(input)`. As in [Configuration](./configuration.md), the two are never mixed field by field: `configureEdgeNats` ignores the environment.

| Variable | Meaning | Default |
| --- | --- | --- |
| `NATS_WS_SERVERS` | Comma separated `ws://` or `wss://` URLs. Required unless `NATS_SYNADIA` is set | none |
| `NATS_SYNADIA` | Uses the Synadia Cloud WebSocket endpoint for the region | off |
| `NATS_NAME` | Connection name | `next-nats-edge` |
| `NATS_TIMEOUT` | Connect timeout, Go style text or milliseconds | `10s` |
| `NATS_MAX_RECONNECT_ATTEMPTS` | `-1` retries forever | `-1` |
| `NATS_RECONNECT_TIME_WAIT` | Time between reconnects, Go style text or milliseconds | `2s` |
| `NATS_JS_DOMAIN`, `NATS_JS_API_PREFIX` | JetStream scope, mutually exclusive | none |

Authentication uses the variables in [Configuration](./configuration.md#authentication): `NATS_CREDS`, `NATS_NKEY`, `NATS_JWT` with `NATS_SEED`, `NATS_USER` with `NATS_PASSWORD`, and `NATS_TOKEN`. `NATS_CREDS` and `NATS_NKEY` accept `data:;base64,` and `env://` values. A file path or `file://` value in `NATS_CREDS`, `NATS_NKEY`, `NATS_JWT`, `NATS_SEED`, `NATS_TOKEN` or `NATS_PASSWORD` is rejected with `UNSUPPORTED_AUTH` because the Edge runtime has no file system. TLS file options are not available.

A missing server list fails with `MISSING_WS_SERVERS`.

## Connection lifecycle

One connection is cached per isolate on `globalThis`. Concurrent first calls share one attempt. A failed attempt is not cached. When the connection closes or drains, the next call opens a new one. Transient network loss is handled by the client reconnect loop.

The edge entry does not install signal handlers, lifecycle events or health state.
