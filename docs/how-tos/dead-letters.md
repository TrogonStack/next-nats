# Handle dead letters

React to messages that a JetStream consumer gave up on, with the original message in hand.

## Watch a stream

```ts
import { defineDeadLetterConsumer } from "@trogonstack/next-nats";

defineDeadLetterConsumer({
  stream: "ORDERS",
  durable: "orders-dead-letters",
  handler: async (event, original) => {
    console.log(event.kind, event.consumer, event.streamSeq, event.reason);
    if (original) await quarantine(original.subject, original.payload);
  },
  onError: (error) => console.error(error),
});
```

`original` is `undefined` when the message was deleted or the stream is gone, so the handler must cope with that. The consumer runs only on processes with `NATS_WORKERS=true`.

Without `capture` this uses a core subscription. Advisories published while no worker is subscribed are lost. Workers share the load through the `durable` queue group.

## Keep advisories durable

Create a stream that stores the advisories, and name it as `capture`:

```ts
import { defineDeadLetterConsumer, ensureDeadLetterCaptureStream } from "@trogonstack/next-nats";

await ensureDeadLetterCaptureStream({ name: "DEAD_LETTERS", streams: ["ORDERS"], maxAge: "30d" });

defineDeadLetterConsumer({
  stream: "ORDERS",
  durable: "orders-dead-letters",
  capture: "DEAD_LETTERS",
  handler: (event, original) => {},
});
```

The consumer becomes a durable pull consumer on `DEAD_LETTERS`, so a restart or an outage does not skip advisories and a failing handler is retried.

Do not point `streams` at the capture stream itself.

## Declare it at startup

Pass the same definitions to `registerNats`, with the capture stream first in `streams`. See [Provision streams declaratively](./declarative-streams.md).

## Related

- [Dead letters reference](../references/dead-letter.md)
- [Queue how-to](./queue.md) for `defineConsumer` and its `deadLetter` subject
