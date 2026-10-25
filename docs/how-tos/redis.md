# Use the Upstash Redis client

Replace `@upstash/redis` with a NATS KV bucket by changing the import specifier.

```ts
import { Redis } from "@trogonstack/next-nats/redis";

const redis = new Redis({ bucket: "app" });
// or: const redis = Redis.fromEnv();

await redis.set("user:1", { name: "ada" }, { ex: 60 });
await redis.rpush("jobs", "a", "b");
await redis.zadd("board", { score: 10, member: "ada" });
```

`Redis.fromEnv()` reads `NEXT_NATS_KV_BUCKET` and falls back to `kv`. The `url` and `token` options are accepted and ignored.

## Batch commands

```ts
const [ok, count] = await redis.pipeline().set("a", 1).incr("a").exec();
```

`multi()` has the same shape. See the [Redis reference](../references/redis.md) for how it differs from a real transaction.

## Keep raw strings

Pass `automaticDeserialization: false` to get back exactly what was stored instead of parsed JSON.

## Check what is supported

Scripting, JSON, streams and a few other command families are not available. The [Redis reference](../references/redis.md) lists them.
