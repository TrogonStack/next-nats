# Core

Exports of `next-nats`.

## Connection

| Export | Description |
| --- | --- |
| `configureNats(input)` | Set configuration before the first connection |
| `getNatsConfig()` | Resolved `NatsConfig` |
| `connectNats(input?)` | Open a separate connection |
| `getNats()` | Shared `{ nc, js, jsm, ... }` handle, connecting on first use |
| `peekNats()` | The handle if already connected |
| `getNc`, `getJs`, `getJsm`, `getKvm`, `getObjm` | Individual clients from the shared handle |
| `openKv(bucket, options)` | Create or open a KV bucket, cached per process. Options: `create`, `history`, `ttl`, `markerTtl`, `maxBytes`, `replicas`, `description` |
| `onNatsStatus(listener)` | Subscribe to connection status events. Returns an unsubscribe function |
| `onNatsShutdown(hook)` | Register a hook run on close. Returns an unregister function |
| `closeNats()` | Drain and close |
| `buildAuthenticator`, `buildConnectionOptions` | Translate config into transport options |
| `resolveConfig`, `parseServers`, `authFromEnv`, `tlsFromEnv`, `decodeCreds` | Config helpers |

## Values

Branded string types and constructors that validate their input: `Subject` and `subject()`, `StreamName` and `streamName()`, `BucketName` and `bucketName()`, `DurableName` and `durableName()`, plus the `Brand` helper type.

## Codec

`codec` encodes and decodes JSON payloads: `encodeJson`, `decodeJson`, `tryDecodeJson`.

## Publishing

| Export | Description |
| --- | --- |
| `jsPublish(subject, payload, options?)` | Publish to JetStream and await the ack |
| `corePublish(subject, payload, options?)` | Fire and forget core publish |
| `request(subject, payload, options?)` | Request/reply |
| `NatsEvents` | Interface to augment so subjects have typed payloads |
| `SubjectName`, `PayloadOf`, `PublishOptions` | Supporting types |

## Streams

`ensureStream(spec)` creates the stream or updates it to match. `spec` is a JetStream `StreamConfig` with a required `name`.

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
