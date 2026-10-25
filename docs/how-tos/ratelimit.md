# Rate limit requests

Replace `@upstash/ratelimit` with counters in a NATS KV bucket.

```ts
import { Ratelimit } from "next-nats/ratelimit";

const limiter = new Ratelimit({ limiter: Ratelimit.slidingWindow(5, "10 s"), prefix: "api" });

export async function GET(request: Request) {
  const id = request.headers.get("x-forwarded-for") ?? "local";
  const { success, remaining } = await limiter.limit(id);
  if (!success) return Response.json({ error: "Too Many Requests" }, { status: 429 });
  return Response.json({ ok: true, remaining });
}
```

## Choose an algorithm

- `Ratelimit.fixedWindow(tokens, window)`
- `Ratelimit.slidingWindow(tokens, window)`
- `Ratelimit.tokenBucket(refillRate, interval, maxTokens)`

Durations look like `"10 s"` or `"1m"`.

## Wait instead of reject

```ts
const res = await limiter.blockUntilReady(id, 5_000);
```

It retries until a slot opens or the next reset would pass the timeout.

## Use another bucket

Pass `kv: createKv({ bucket: "limits" })` to the constructor.
