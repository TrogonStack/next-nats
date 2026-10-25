# next-nats

Vercel platform primitives for self-hosted Next.js, running on NATS and JetStream. One `nats-server` replaces the managed KV, Blob, Queues, Edge Config, cache and cron services, and every Next.js replica shares the same state.

```ts
// next.config.ts
import { withNats } from "@trogonstack/next-nats/next";

export default withNats({ cacheComponents: true }, { cache: true });
```

## Primitives

| Vercel primitive | Import |
| --- | --- |
| Redis | `@trogonstack/next-nats/redis` |
| KV | `@trogonstack/next-nats/kv` |
| Blob | `@trogonstack/next-nats/blob` |
| Queues | `@trogonstack/next-nats/queue` |
| Edge Config | `@trogonstack/next-nats/edge-config` |
| Data Cache and `use cache` | `@trogonstack/next-nats/cache`, wired by `@trogonstack/next-nats/next` |
| Rate limiting | `@trogonstack/next-nats/ratelimit` |
| Realtime and streaming | `@trogonstack/next-nats/realtime` |
| Services and RPC | `@trogonstack/next-nats/services` |
| Cron Jobs | `@trogonstack/next-nats/cron` |
| Health | `@trogonstack/next-nats/health` |

## Quick start

```sh
mise run compose:up
mise run install
mise run demo:start
```

## Documentation

- [Tutorials](./docs/tutorials/README.md)
- [How-tos](./docs/how-tos/README.md)
- [References](./docs/references/README.md)
- [Explanations](./docs/explanations/README.md)

## License

[Apache-2.0](./LICENSE)
