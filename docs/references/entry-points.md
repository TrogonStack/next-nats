# Entry points

Every module is a subpath export of the `next-nats` package. Server modules import `server-only`.

| Import | Purpose |
| --- | --- |
| `next-nats` | [Core](./core.md): connection, config, publishing, streams, consumers, `raw` |
| `next-nats/instrumentation` | `registerNats` for `instrumentation.ts` |
| `next-nats/kv` | [KV](./kv.md) |
| `next-nats/blob` | [Blob](./blob.md) |
| `next-nats/queue` | [Queue](./queue.md) |
| `next-nats/edge-config` | [Edge Config](./edge-config.md) |
| `next-nats/cache` | [Cache](./cache.md) stores and handler factories |
| `next-nats/cache/use-cache-handler` | Handler module for `cacheHandlers` |
| `next-nats/cache/incremental-handler` | Handler module for `cacheHandler` |
| `next-nats/ratelimit` | [Rate limit](./ratelimit.md) |
| `next-nats/realtime` | [Realtime](./realtime.md) server relays |
| `next-nats/realtime/client` | `useNatsEvents` React hook |
| `next-nats/services` | [Services](./services.md) |
| `next-nats/cron` | [Cron](./cron.md) |
| `next-nats/health` | [Health](./health.md) handler factories |
| `next-nats/health/readiness` | Readiness route handler |
| `next-nats/health/liveness` | Liveness route handler |
| `next-nats/next` | `withNats` for `next.config.ts` |

Peer dependencies are `next` and, optionally, `react`.

## registerNats

`registerNats(options)` from `next-nats/instrumentation` connects and runs a setup callback. It does nothing outside the Node.js runtime.

| Option | Meaning |
| --- | --- |
| `config` | `NatsConfigInput` applied before connecting |
| `setup` | Callback run after connecting, usually a dynamic import of the module that defines consumers, services and crons |
| `connectOnStart` | Connect eagerly. Defaults to `true` |
| `onError` | Receives connection and setup failures. Defaults to logging |
