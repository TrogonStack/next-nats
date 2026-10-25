# Queue

Exports of `@trogonstack/next-nats/queue`, mirroring `@vercel/queue@0.10.0`. Parity is asserted against the real package types in `queue.parity.test.ts`.

## Functions

| Function | Description |
| --- | --- |
| `send(topic, payload, options?)` | Publish one message. Resolves `{ messageId }` |
| `sendBatch(topic, messages, options?)` | Publish many, 1 to 100. Each result is `sent` or `failed` with `statusCode`, `error` and `retryable` |
| `experimental_sendBatch` | Same as `sendBatch` |
| `handleCallback(handler, options?)` | Route handler for a `POST` CloudEvent callback |
| `registerDevConsumer(options)` | In-process consumer. Returns an unregister function |
| `parseCallback`, `parseRawCallback` | Parse a callback request |

## Classes

| Class | Description |
| --- | --- |
| `QueueClient` | `send`, `sendBatch`, `experimental_sendBatch`, `handleCallback`, `handleNodeCallback` |
| `PollingQueueClient` | `send`, `sendBatch`, `experimental_sendBatch`, `receive(topic, consumerGroup, handler, options?)` |
| `JsonTransport`, `BufferTransport`, `StreamTransport` | Payload serialization |

Constructors accept the real options plus `nats: { stream?, prefix? }`.

Error classes and the `CLOUD_EVENT_TYPE_V1BETA` and `CLOUD_EVENT_TYPE_V2BETA` constants have the names, messages and values of the real package.

## NATS additions

| Export | Description |
| --- | --- |
| `startQueueWorker(options?)` | Delivers messages to the routes declared in `vercel.json`. Returns `{ triggers, stop() }` |
| `configureQueue({ stream?, prefix? })` | Default stream and subject prefix |
| `filePathToConsumerGroup(path)`, `routePathOf(path)`, `loadTriggers(config)` | Helpers used by the worker |

## Send options

`idempotencyKey`, `retentionSeconds`, `delaySeconds`, `headers`.

## Receive options

`limit`, `visibilityTimeoutSeconds`, `retry(error, metadata)`, `cursorFallback`. A retry directive is `{ afterSeconds }` or `{ acknowledge: true }`.

## Message metadata

`messageId`, `deliveryCount`, `createdAt`, `expiresAt`, `topicName`, `consumerGroup`, `region`.

## Configuration

| Setting | Default |
| --- | --- |
| `NATS_QUEUE_STREAM` | `QUEUE` |
| `NATS_QUEUE_PREFIX` | `queue` |
| `NATS_QUEUE_CALLBACK_URL` | `http://127.0.0.1:$PORT` |
| `NATS_QUEUE_SECRET` | Unset. When set, receipt handles are signed |
| `NATS_WORKERS` | Must be `true` for `startQueueWorker` and `registerDevConsumer` |

Defaults follow the real package: visibility timeout 300 seconds (clamped to 30 to 3600), retention one day (60 seconds to seven days), delay up to the retention.

## Differences from Vercel Queues

- `receive` by `messageId`, `experimental_concurrencyKey` and v1 structured or receipt-less callbacks throw `BadRequestError`.
- Coalescing options are accepted and ignored. `experimental_handoff` behaves like `afterSeconds`.
- `token`, `deploymentId`, `dispatcher`, `resolveBaseUrl` and telemetry options are accepted and ignored.
- `region` is metadata. All regions share one stream.
- The acknowledgement wait is a property of the consumer, so the visibility timeout of a route handler only sets the renewal interval.
- `StreamTransport` buffers the stream before publishing. Payloads above the NATS maximum throw `PayloadTooLargeError`.
- `sendBatch` publishes each message separately and never reports `deferred`.
- Handlers are not registered automatically from the call stack. Declare triggers in `vercel.json` or call `registerDevConsumer`.
- The default `retryAfterSeconds` is 60, because the real default is not documented in the package.
- There is no dead letter queue and no delivery limit, as in the real package.
