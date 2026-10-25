# next-nats

Vercel platform primitives for self-hosted Next.js, running on NATS and JetStream. One `nats-server` replaces the managed KV, Blob, Queues, Edge Config, cache and cron services, and every Next.js replica shares the same state.

```ts
// next.config.ts
import { withNats } from "next-nats/next";

export default withNats({ cacheComponents: true }, { cache: true });
```

## Primitives

| Vercel primitive | Import |
| --- | --- |
| KV | `next-nats/kv` |
| Blob | `next-nats/blob` |
| Queues | `next-nats/queue` |
| Edge Config | `next-nats/edge-config` |
| Data Cache and `use cache` | `next-nats/cache`, wired by `next-nats/next` |
| Rate limiting | `next-nats/ratelimit` |
| Realtime and streaming | `next-nats/realtime` |
| Services and RPC | `next-nats/services` |
| Cron Jobs | `next-nats/cron` |
| Health | `next-nats/health` |

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
