# Queue

Exports of `next-nats/queue`.

## Functions

The module-level functions use a default client, replaceable with `configureQueue(options)`. `defaultQueue()` returns it and `createQueueClient(options)` builds an independent one.

| Function | Description |
| --- | --- |
| `send(topic, payload, options?)` | Publish one message. Resolves `{ messageId }` |
| `sendBatch(topic, messages)` | Publish many. Each result is `sent` or `failed` with `statusCode`, `error` and `retryable` |
| `subscribe(topic, consumerGroup, handler, options?)` | Long-running consumer. Returns a `QueueSubscription` with `stop()` |
| `receive(topic, consumerGroup, handler, options?)` | Pull a bounded batch. Resolves `{ ok: true, processed }` or `{ ok: false, reason: "empty" }` |
| `handleCallback(handler, options?)` | Route handler: `POST` with `{ queueName, consumerGroup }` |
| `defaultRetryDelaySeconds(deliveryCount)` | Exponential delay capped at 300 seconds |

## Send options

`idempotencyKey`, `retentionSeconds`, `delaySeconds`, `headers`.

## Consume options

| Option | Meaning |
| --- | --- |
| `visibilityTimeoutSeconds` | Time to process before redelivery |
| `retry(error, metadata)` | Return `{ afterSeconds }` to delay or `{ acknowledge: true }` to drop |
| `concurrency` | Parallel handlers (`subscribe` only) |
| `maxDeliveries` | Attempts before the message is dropped |
| `cursorFallback` | `earliest` or `latest` for a new group |
| `onError` | Receives handler failures |

`receive` also takes `limit` and `waitSeconds`.

## Message metadata

`messageId`, `deliveryCount`, `createdAt`, `expiresAt`, `topicName`, `consumerGroup`, `region`, `headers`.

## Client options

| Option | Default |
| --- | --- |
| `stream` | `QUEUE` |
| `prefix` | `queue` |
| `retentionSeconds` | one day |
| `maxRetentionSeconds` | seven days |
| `duplicateWindowSeconds` | `3600`, capped by max retention |
| `region` | `nats` |
