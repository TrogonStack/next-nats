# Use KV

Replace `@vercel/kv` with a NATS KV bucket.

```ts
import { kv } from "@trogonstack/next-nats/kv";

await kv.set("user:1", { name: "ada" }, { ex: 60 });
const user = await kv.get<{ name: string }>("user:1");
await kv.incr("hits");
await kv.hset("session:1", { theme: "dark" });
```

## Use another bucket

`kv` reads `NEXT_NATS_KV_BUCKET` and falls back to `kv`. For a second bucket:

```ts
import { createKv } from "@trogonstack/next-nats/kv";

const sessions = createKv({ bucket: "sessions" });
```

## Set only when absent

```ts
const created = await kv.set("lock:report", "me", { nx: true, ex: 30 });
```

## Check what is supported

Not every Redis command exists. The [KV reference](../references/kv.md) lists the supported commands and the semantic differences.
