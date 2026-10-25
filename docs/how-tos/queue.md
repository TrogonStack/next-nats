# Send and handle queue messages

Replace Vercel Queues with a JetStream stream and pull consumers.

## Send

```ts
import { send } from "@trogonstack/next-nats/queue";

await send("orders", { id: "o_1" }, { idempotencyKey: "o_1", delaySeconds: 10 });
```

`sendBatch` sends several messages and reports a result for each.

## Handle continuously

Register handlers where workers run, for example in the module loaded by `registerNats`:

```ts
import { subscribe } from "@trogonstack/next-nats/queue";

subscribe<{ id: string }>(
  "orders",
  "fulfilment",
  async (order, meta) => {
    if (meta.deliveryCount < 3) throw new Error("try again");
  },
  { retry: () => ({ afterSeconds: 2 }) },
);
```

Replicas that share a consumer group split the messages. A handler that throws is redelivered, and `maxDeliveries` bounds the attempts.

## Handle on demand

`receive` pulls a bounded batch and returns `{ ok: false, reason: "empty" }` when there was nothing. `handleCallback` builds a route handler that accepts a `POST` with `{ queueName, consumerGroup }` and drains that queue.

## Consume a plain JetStream subject

For subjects outside the queue, with dead letters, use `defineConsumer`:

```ts
import { defineConsumer, ensureStream } from "@trogonstack/next-nats";

await ensureStream({ name: "EVENTS", subjects: ["events.>", "events.dlq"] });

defineConsumer<{ message: string }>({
  stream: "EVENTS",
  durable: "event-logger",
  filterSubjects: ["events.>"],
  maxDeliver: 3,
  backoff: [500, 1_000],
  deadLetter: { subject: "events.dlq" },
  handler: (payload) => console.log(payload.message),
});
```

## Enable workers

Handlers only start when `NATS_WORKERS=true` for the process. See [workers](../explanations/architecture.md#workers).
