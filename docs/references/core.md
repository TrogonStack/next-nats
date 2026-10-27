# Core

Exports of `@trogonstack/next-nats`.

## Connection

| Export | Description |
| --- | --- |
| `configureNats(input)` | Set configuration before the first connection. Takes a `NatsConfigInput`, never reads the environment |
| `getNatsConfig()` | Resolved `NatsConfig` |
| `connectNats(input?)` | Open a separate connection |
| `getNats()` | Shared `{ nc, js, jsm, ... }` handle, connecting on first use |
| `peekNats()` | The handle if already connected |
| `getNc`, `getJs`, `getJsm`, `getKvm`, `getObjm` | Individual clients from the shared handle |
| `openKv(bucket, options)` | Create or open a KV bucket, cached per process. Options: `create`, `history`, `ttl`, `markerTtl`, `maxBytes`, `replicas`, `description` |
| `onNatsStatus(listener)` | Subscribe to connection status events. Returns an unsubscribe function |
| `onNatsShutdown(hook)` | Register a hook run on close. Returns an unregister function |
| `getJsIfAvailable()` | The JetStream client, or `undefined` when the account has no JetStream. The probe is cached per connection |
| `openObj(bucket, options)` | Create or open an Object Store bucket, cached per process. Options: `create`, `ttl`, `maxBytes`, `replicas`, `description`, `compression` |
| `closeNats()` | Drain and close |
| `buildAuthenticator`, `buildConnectionOptions` | Translate config into transport options |
| `natsConfig(input?)`, `natsConfigFromEnv(env?)` | Build a `NatsConfig` from code or from the environment. See [Configuration](./configuration.md) |
| `parseServers`, `authFromEnv`, `tlsFromEnv`, `decodeCreds` | Config helpers |

## Lifecycle hooks

Each hook takes a listener and returns an unsubscribe function. A throwing listener does not affect the others.

| Hook | Event |
| --- | --- |
| `onNatsConnectError(listener)` | `{ error, kind }`, where `kind` is `initial` for a failed first connect and `auth` for an authentication failure |
| `onNatsDisconnect(listener)` | `{ server }` |
| `onNatsReconnect(listener)` | `{ server, downtimeMs }`, once per outage |

## Credentials

`CredentialsExpiredError` carries `expiresAt` and is thrown at connect time for an expired JWT or creds. See [Configuration](./configuration.md#authentication).

## Synadia

`synadiaRegion(value)` validates a region, `DEFAULT_SYNADIA_REGION` is `global`, and `synadiaServers(region)` returns the `servers` and `wsServers` of that region.

## Values

Branded string types and constructors that validate their input: `Subject` and `subject()`, `StreamName` and `streamName()`, `BucketName` and `bucketName()`, `DurableName` and `durableName()`, plus the `Brand` helper type.

## Secret

`Secret` wraps a sensitive string so it does not leak through logging or serialization. See [Secrets](./configuration.md#secrets).

## Codec

`codec` encodes and decodes JSON payloads: `encodeJson`, `decodeJson`, `tryDecodeJson`.

## Publishing

| Export | Description |
| --- | --- |
| `jsPublish(subject, payload, options?)` | Publish to JetStream and await the ack, optionally with retry |
| `corePublish(subject, payload, options?)` | Fire and forget core publish |
| `request(subject, payload, options?)` | Request/reply |
| `NatsEvents` | Interface to augment so subjects have typed payloads |
| `SubjectName`, `PayloadOf`, `PublishOptions`, `RetryOptions`, `BackoffOptions`, `TraceOptions` | Supporting types |
| `isRetriablePublishError(error)` | The default retry predicate |
| `retryDelay(attempt, backoff?, random?)` | The delay in milliseconds before the next attempt |

`PublishOptions` fields: `msgId`, `headers`, `timeout`, `retry`, and the trace options `trace`, `traceparent` and `tracestate`. `corePublish` and `request` accept `headers` and the trace options. `request` also accepts `timeout`.

### Retry

`retry: { attempts, backoff?, retryable? }` makes `jsPublish` try up to `attempts` times in total. `backoff` takes `initial` (100 ms), `max` (2000 ms), `multiplier` (2) and `jitter` (0.5, a ratio from 0 to 1 that shortens each delay by up to that share). `retryable` replaces the default predicate.

The default predicate retries timeouts, no responders (including a JetStream that has no stream for the subject yet), connection errors and closed connections, looking through `cause` chains. It never retries a `JetStreamApiError` such as wrong last sequence, and it never retries unknown errors.

When `attempts` is greater than 1 and no `msgId` is given, one random message id is generated and reused by every attempt, so the stream's duplicate window removes a message that was stored by an attempt whose ack was lost. The ack of a later attempt then reports `duplicate: true`. Retries spread over longer than the stream's duplicate window can still store the message twice.

### Trace context

`TraceContext` validates and formats the W3C `traceparent` and `tracestate` headers. Pass `trace` to `jsPublish`, `corePublish` or `request` to send both headers. The `traceparent` string option still works and is parsed through `TraceContext`, so an invalid value throws an `InvalidArgumentError`; `tracestate` pairs with it.

| Member | Description |
| --- | --- |
| `TraceContext.parse(traceparent, tracestate?)` | Parse and validate, throwing on bad input. Version `ff`, all zero ids, uppercase hex and invalid `tracestate` members are rejected |
| `TraceContext.tryParse(traceparent, tracestate?)` | Same, returning `undefined` |
| `TraceContext.generate({ traceId?, parentId?, sampled?, tracestate? })` | Create a context with random ids |
| `TraceContext.fromHeaders(headers)` | Read the trace of a received message |
| `traceId`, `parentId`, `flags`, `sampled`, `tracestate`, `traceparent` | Fields |
| `child()`, `withTracestate(value)`, `equals(other)` | Derive and compare |

## Durations

`Duration.parse("90s")`, `Duration.ofMillis(ms)` and `Duration.ofNanos(n)` create a `Duration` value object with `toNanos()`, `toMillis()` and `equals()`. Text is Go style: `ns`, `us`, `ms`, `s`, `m`, `h`, concatenated as in `"1h30m"`, plus `d` for days as an extension. `duration(input)` accepts a `Duration`, text, or a number of milliseconds.

## Streams

| Export | Description |
| --- | --- |
| `ensureStream(spec)` | Create the stream, or update it to match `spec` when its configuration differs. Returns the `StreamInfo` |
| `defineStream(spec, { provision? })` | A `StreamDefinition` with `ensure()`, for declarative registration |
| `ProvisionMode`, `provisionMode(value)` | The provision mode value type and its validating constructor |
| `toStreamConfig(spec)`, `streamDrift(current, desired)` | Pure helpers: map a spec to a JetStream config, list the fields that differ |

`StreamSpec` is a JetStream `StreamConfig` with a required `name`, plus friendly fields: `maxAge` and `duplicateWindow` (`Duration`, text or milliseconds), `replicas` (1 to 5), `maxBytes` and `placement` (`{ cluster?, tags? }`). The raw fields (`retention`, `storage`, `subjects`, `max_age`, `num_replicas` and the rest) keep working, and a friendly field wins over its raw twin.

`ensureStream` only sends an update when a field in the spec differs from the live stream, comparing `subjects` as a set. JetStream rejects updates to immutable fields such as `retention` and `storage`, and that error is thrown.

Provision modes: `never` verifies the stream exists and throws a `FailedPreconditionError` otherwise, `startup` creates it when missing and leaves an existing stream alone, `update` creates or reconciles it like `ensureStream`. The default is `startup`.

See [Provision streams declaratively](../how-tos/declarative-streams.md).

## Consumers

`defineConsumer(definition)` starts a durable pull consumer when workers are enabled and returns an `ActiveConsumer` with `durable` and `stop()`. Definitions are deduplicated by stream and durable name. `stopAllConsumers()` stops all of them.

| Field | Meaning |
| --- | --- |
| `stream`, `durable` | Where the consumer lives |
| `filterSubjects` | Subjects to consume |
| `ackWait`, `maxDeliver`, `backoff`, `maxAckPending` | Redelivery behaviour |
| `deadLetter` | `{ subject }` receiving messages that exhaust deliveries |
| `provision` | Create the consumer if missing |
| `handler(payload, msg)` | Receives the decoded payload and the raw message |
| `onError` | Receives handler and loop failures |

## raw

`raw` namespaces the underlying clients for code that needs to bypass the typed surface: `core`, `jetstream`, `kv`, `obj` and `micro`.
