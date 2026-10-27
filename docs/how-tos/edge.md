# Use NATS from the Edge runtime

Publish, read KV, call services and stream subjects from middleware or a route with `export const runtime = "edge"`. Next rejects `runtime = "edge"` route handlers when `cacheComponents` is on, so use middleware there.

```ts
// middleware.ts
import { corePublish } from "@trogonstack/next-nats/edge";

export async function middleware(request: Request) {
  await corePublish("web.request", { url: request.url });
}
```

```ts
import { jsPublish } from "@trogonstack/next-nats/edge";

const ack = await jsPublish("orders.created", { id: "o-1" }, { msgId: "o-1", retry: { attempts: 3 } });
```

Set the WebSocket endpoint of your server.

```sh
NATS_WS_SERVERS=wss://nats.example.com:443
NATS_TOKEN=...
```

The NATS server must enable `websocket` in its config. Pass a trace with `{ trace }` or `{ traceparent }` to propagate it, as in the Node entry.

With `withNats` and its incremental cache, the cache handler is a pass-through in the Edge runtime: it serves misses and drops writes, and the Node-only backend is never part of the middleware bundle.

## Read and write KV

```ts
import { edgeKv } from "@trogonstack/next-nats/edge";

const flags = edgeKv("flags");
const entry = await flags.get<{ enabled: boolean }>("checkout");
if (entry?.value.enabled) {
  await flags.put("checkout-seen", "1", { ttlSeconds: 60 });
}
```

The bucket must already exist. Edge never provisions, so create it from the Node runtime with `kv` or `openKv`; opening a missing bucket fails with `BUCKET_NOT_FOUND`. `edgeKv` reads and writes the same records as the Node `kv` entry, so a value set with `kv.set` reads back identically from `edgeKv` and the other way round, expiry included. Only string values are visible: a key holding a hash, list, set or sorted set fails with `WRONG_TYPE`.

## Call a service

```ts
import { edgeRequest, EdgeRequestError } from "@trogonstack/next-nats/edge";

try {
  const reply = await edgeRequest("calculator.add", { a: 2, b: 3 }, { timeout: 2_000 });
  return Response.json(reply.json());
} catch (error) {
  if (error instanceof EdgeRequestError) return Response.json({ error: error.message }, { status: error.status });
  throw error;
}
```

Typed subjects declared through `NatsEvents` type the payload, as with publishing. Service errors (`Nats-Service-Error-Code`) surface as `EdgeRequestError` with `kind: "service"`.

## Stream a subject over SSE

```ts
import { edgeSseFromSubject } from "@trogonstack/next-nats/edge";

export const runtime = "edge";

export function GET(request: Request) {
  return edgeSseFromSubject(request, "demo.events");
}
```

The subscription ends when the client disconnects. Edge platforms cap how long a response may stay open, so clients should reconnect: the response sends a `retry` hint. For custom framing, `edgeSubscribe(subject, { signal })` returns a `ReadableStream` of messages that closes and unsubscribes on abort.

Do not import `@trogonstack/next-nats` itself in edge code: it loads the TCP transport. See the [Edge reference](../references/edge.md) for the full surface.
