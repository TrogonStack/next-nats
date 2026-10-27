# Send and handle queue messages

Run the same `@vercel/queue` code on JetStream by importing from `@trogonstack/next-nats/queue`.

## Send

```ts
import { send } from "@trogonstack/next-nats/queue";

await send("orders", { id: "o_1" }, { idempotencyKey: "o_1", delaySeconds: 10 });
```

`sendBatch` sends several messages and reports `sent` or `failed` for each.

## Handle in a route handler

```ts
// src/app/api/queue/orders/route.ts
import { handleCallback } from "@trogonstack/next-nats/queue";

export const POST = handleCallback<{ id: string }>(
  async (order, metadata) => {
    if (metadata.deliveryCount < 3) throw new Error("try again");
  },
  { retry: () => ({ afterSeconds: 2 }) },
);
```

Declare the trigger in `vercel.json`, exactly as for Vercel:

```json
{
  "functions": {
    "src/app/api/queue/orders/route.ts": {
      "experimentalTriggers": [{ "type": "queue/v2beta", "topic": "orders", "retryAfterSeconds": 30 }]
    }
  }
}
```

## Deliver messages to the route

On Vercel the platform calls the route. Self-hosted, start the worker in a module that loads with the server, for example the one imported by `registerNats`:

```ts
import { startQueueWorker } from "@trogonstack/next-nats/queue";

startQueueWorker();
```

The worker reads `vercel.json`, derives the consumer group from the file path, and posts each message to the route as a CloudEvent. A non-2xx answer redelivers the message after `retryAfterSeconds`. Set `NATS_QUEUE_CALLBACK_URL` when the route is not reachable at `http://127.0.0.1:$PORT`.

The worker does not create the stream. It waits until `send` or another process creates it, so an app that never sends holds no `QUEUE` stream.

Replicas that share a consumer group split the messages. Every other consumer group gets its own copy.

## Handle in process during development

```ts
import { QueueClient, registerDevConsumer } from "@trogonstack/next-nats/queue";

const unregister = registerDevConsumer({
  topic: "orders",
  client: new QueueClient(),
  handler: async (order) => console.log(order),
});
```

## Pull on demand

```ts
import { PollingQueueClient } from "@trogonstack/next-nats/queue";

const client = new PollingQueueClient({});
const result = await client.receive("orders", "batch-job", async (order) => {}, { limit: 5 });
```

`receive` resolves `{ ok: false, reason: "empty" }` when there was nothing.

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

`startQueueWorker` and `registerDevConsumer` only start when `NATS_WORKERS=true` for the process. See [workers](../explanations/architecture.md#workers).
