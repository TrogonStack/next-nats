# Stream realtime events to the browser

Relay NATS subjects and JetStream streams over Server-Sent Events.

## From a core subject

```ts
// app/api/cursors/route.ts
import { connection } from "next/server";
import { sseFromSubject } from "next-nats/realtime";

export async function GET(request: Request) {
  await connection();
  return sseFromSubject(request, "cursors.>", { event: "cursor" });
}
```

`filter` drops messages and `transform` reshapes them before they are sent.

## From a stream, with replay

```ts
import { sseFromStream } from "next-nats/realtime";

export async function GET(request: Request) {
  await connection();
  return sseFromStream(request, { stream: "FEED", filterSubjects: ["feed.>"], deliver: "all" });
}
```

The consumer is ordered. A reconnecting browser sends `Last-Event-ID`, and the stream resumes after that sequence.

## Publish

```ts
import { corePublish, jsPublish } from "next-nats";

await corePublish("cursors.ada", { x: 1, y: 2 });
await jsPublish("feed.post", { text: "hello" });
```

## Subscribe in a client component

```tsx
"use client";
import { useNatsEvents } from "next-nats/realtime/client";

const { events, status } = useNatsEvents<{ text: string }>({ url: "/api/realtime/feed" });
```
