# Provision streams declaratively

Declare streams, consumers and dead letter consumers once, in `instrumentation.ts`.

```ts
import { defineStream, deadLetterCaptureSpec } from "@trogonstack/next-nats";

export async function register() {
  const { registerNats } = await import("@trogonstack/next-nats/instrumentation");
  await registerNats({
    streams: [
      defineStream(
        { name: "ORDERS", subjects: ["orders.>"], maxAge: "24h", duplicateWindow: "90s", replicas: 3, storage: "file" },
        { provision: "update" },
      ),
      defineStream(deadLetterCaptureSpec({ name: "DEAD_LETTERS", streams: ["ORDERS"] })),
    ],
    consumers: [
      { stream: "ORDERS", durable: "billing", filterSubjects: ["orders.paid"], handler: async (order) => {} },
    ],
    deadLetterConsumers: [
      { stream: "ORDERS", durable: "orders-dead-letters", capture: "DEAD_LETTERS", handler: async (event, original) => {} },
    ],
  });
}
```

Streams are provisioned first, in order, then consumers and dead letter consumers start. A failing stream is reported to `onError` and the rest continue.

## Choose a provision mode

| Mode | Use it when |
| --- | --- |
| `never` | Another system owns the stream. The call fails when it is missing |
| `startup` | Create the stream if it is missing and never touch an existing one. This is the default |
| `update` | The code owns the stream. It is created or reconciled on every start |

`update` changes only the fields you set. JetStream refuses to change some fields on an existing stream, such as `retention` and `storage`, and the error reaches `onError`.

## Write durations as text

`maxAge` and `duplicateWindow` accept Go style text such as `"24h"`, `"90s"` and `"1h30m"`, a `Duration`, or milliseconds. See [Durations](../references/core.md#durations).

## Create one stream imperatively

`ensureStream(spec)` does what `update` does, outside of `registerNats`.

## Related

- [Core reference](../references/core.md#streams)
- [Handle dead letters](./dead-letters.md)
