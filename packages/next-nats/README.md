# @trogonstack/next-nats

Run the Vercel platform features your Next.js app depends on (Redis, KV, Blob, Queues, Edge Config, the Data Cache and Cron Jobs) on a NATS server you operate. Each subpath mirrors the API of the package Vercel promotes, so moving an app off Vercel means changing import specifiers, not application code.

## Install

```sh
npm install @trogonstack/next-nats
```

Requires Next.js 16 or later, React 19 or later, and a NATS server with JetStream enabled.

## Usage

Wrap the Next.js config so the Vercel imports resolve to next-nats when the app is not built on Vercel:

```ts
// next.config.ts
import { withNats } from "@trogonstack/next-nats/next";

export default withNats({ cacheComponents: true }, { cache: true });
```

Connect on startup:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNats } = await import("@trogonstack/next-nats/instrumentation");
    await registerNats();
  }
}
```

Point it at your server with `NATS_URL`, then use a primitive the same way you would on Vercel:

```ts
import { kv } from "@trogonstack/next-nats/kv";

await kv.set("greeting", "hello");
```

## Primitives

| Vercel primitive | Import |
| --- | --- |
| Redis | `@trogonstack/next-nats/redis` |
| KV | `@trogonstack/next-nats/kv` |
| Blob | `@trogonstack/next-nats/blob`, `@trogonstack/next-nats/blob/client` |
| Queues | `@trogonstack/next-nats/queue` |
| Edge Config | `@trogonstack/next-nats/edge-config` |
| Data Cache and `use cache` | `@trogonstack/next-nats/cache`, wired by `@trogonstack/next-nats/next` |
| Rate limiting | `@trogonstack/next-nats/ratelimit` |
| Realtime and streaming | `@trogonstack/next-nats/realtime` |
| Services and RPC | `@trogonstack/next-nats/services` |
| Cron Jobs | `@trogonstack/next-nats/cron` |
| Health | `@trogonstack/next-nats/health` |

## Documentation

See the [documentation](https://github.com/TrogonStack/next-nats/blob/main/docs/README.md).

## License

[Apache-2.0](./LICENSE)
