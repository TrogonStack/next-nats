# Dead letters

Exports of `@trogonstack/next-nats` that turn JetStream advisories about undeliverable messages into typed events.

| Export | Description |
| --- | --- |
| `defineDeadLetterConsumer(definition)` | Start consuming dead letter advisories and return an `ActiveDeadLetterConsumer` with `durable`, `mode` and `stop()` |
| `toDeadLetterEvent(advisory)` | Pure mapping from a decoded advisory payload to a `DeadLetterEvent` |
| `fetchDeadLetterOriginal(event)` | Read the original message by stream sequence, or `undefined` when it is gone |
| `deadLetterAdvisorySubjects(stream, consumer?)` | The two advisory subjects for a stream and consumer, `*` by default |
| `deadLetterCaptureSpec(options?)`, `ensureDeadLetterCaptureStream(options?)` | The `StreamSpec` of the capture stream, and a call that ensures it |
| `stopAllDeadLetterConsumers()` | Stop every dead letter consumer |

## Definition

| Field | Meaning |
| --- | --- |
| `stream` | The stream whose consumers are watched |
| `durable` | Name of this dead letter consumer. With `capture` it is the durable pull consumer on the capture stream. Without it, it is the core subscription queue group, so each advisory is handled by one worker |
| `filter` | Only watch this consumer of `stream`. Defaults to every consumer |
| `capture` | Name of the stream that stores advisories. Present means durable delivery, absent means a core subscription |
| `handler(event, original)` | Receives the `DeadLetterEvent` and the `DeadLetterOriginal`, or `undefined` when the message was already deleted |
| `onError(error, event?)` | Receives malformed advisories, subscription errors and consumer loop failures |

It starts only when workers are enabled and is deduplicated by mode, capture stream, stream and durable name. It registers shutdown at stage `consumers`. A handler that throws is redelivered by the durable consumer like any `defineConsumer` handler, and is reported to `onError` in core mode without redelivery.

## DeadLetterEvent

| Field | Meaning |
| --- | --- |
| `kind` | `"max_deliveries"` or `"terminated"` |
| `stream`, `consumer` | Where the message was being delivered |
| `streamSeq` | Sequence of the original message in the stream |
| `deliveries` | Delivery attempts made |
| `reason` | Why the message was terminated, only for `terminated` and only when given |
| `consumerSeq`, `domain`, `id`, `timestamp` | Present when the advisory carries them |

`DeadLetterOriginal` carries `subject`, `seq`, `data`, the decoded `payload`, `headers` and `time`.

## Advisories

| Kind | Subject | Schema type |
| --- | --- | --- |
| `max_deliveries` | `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.<stream>.<consumer>` | `io.nats.jetstream.advisory.v1.max_deliver` |
| `terminated` | `$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.<stream>.<consumer>` | `io.nats.jetstream.advisory.v1.terminated` |

The subjects and payload fields (`stream`, `consumer`, `stream_seq`, `deliveries`, and for terminated `consumer_seq` and `reason`, plus optional `domain`) come from `server/jetstream_events.go` and `server/jetstream_api.go` in nats-io/nats-server, the constants `JSConsumerDeliveryExceededAdvisory`, `JSConsumerDeliveryTerminatedAdvisory`, `JSAdvisoryConsumerMaxDeliveryExceedPre` and `JSAdvisoryConsumerMsgTerminatedPre`. `defineConsumer` ends a message with a terminate when deliveries are exhausted, which produces a `terminated` advisory with the reason `maxDeliver <n> exhausted`.

## Capture stream

Advisories are core messages and are lost when nobody listens. `deadLetterCaptureSpec` describes a stream that stores them: subjects for every stream, or for the `streams` you list, `maxAge` of `7d`, name `NEXT_NATS_DEAD_LETTERS` unless `name` is set. It accepts `storage` and `replicas`. See [Handle dead letters](../how-tos/dead-letters.md).
