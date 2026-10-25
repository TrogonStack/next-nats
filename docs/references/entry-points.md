# Entry points

Every module is a subpath export of the `@trogonstack/next-nats` package. Server modules import `server-only`.

| Import | Purpose |
| --- | --- |
| `@trogonstack/next-nats` | [Core](./core.md): connection, config, publishing, streams, consumers, `raw` |
| `@trogonstack/next-nats/instrumentation` | `registerNats` for `instrumentation.ts` |
| `@trogonstack/next-nats/redis` | [Redis](./redis.md) |
| `@trogonstack/next-nats/kv` | [KV](./kv.md) |
| `@trogonstack/next-nats/blob` | [Blob](./blob.md) |
| `@trogonstack/next-nats/blob/client` | Blob client uploads and `handleUpload`, browser safe |
| `@trogonstack/next-nats/queue` | [Queue](./queue.md) |
| `@trogonstack/next-nats/edge-config` | [Edge Config](./edge-config.md) |
| `@trogonstack/next-nats/cache` | [Cache](./cache.md) stores and handler factories |
| `@trogonstack/next-nats/cache/use-cache-handler` | Handler module for `cacheHandlers` |
| `@trogonstack/next-nats/cache/incremental-handler` | Handler module for `cacheHandler` |
| `@trogonstack/next-nats/ratelimit` | [Rate limit](./ratelimit.md) |
| `@trogonstack/next-nats/realtime` | [Realtime](./realtime.md) server relays |
| `@trogonstack/next-nats/realtime/client` | `useNatsEvents` React hook |
| `@trogonstack/next-nats/services` | [Services](./services.md) |
| `@trogonstack/next-nats/cron` | [Cron](./cron.md) |
| `@trogonstack/next-nats/health` | [Health](./health.md) handler factories |
| `@trogonstack/next-nats/health/readiness` | Readiness route handler |
| `@trogonstack/next-nats/health/liveness` | Liveness route handler |
| `@trogonstack/next-nats/next` | `withNats` for `next.config.ts` |

Peer dependencies are `next` and, optionally, `react`.

## registerNats

`registerNats(options)` from `@trogonstack/next-nats/instrumentation` connects and runs a setup callback. It does nothing outside the Node.js runtime.

| Option | Meaning |
| --- | --- |
| `config` | `NatsConfigInput` applied before connecting |
| `setup` | Callback run after connecting, usually a dynamic import of the module that defines consumers, services and crons |
| `connectOnStart` | Connect eagerly. Defaults to `true` |
| `vercelCrons` | `true` or [`VercelCronsOptions`](./cron.md#vercel-crons) starts the crons declared in `vercel.json` |
| `onError` | Receives connection and setup failures. Defaults to logging |
