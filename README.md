# next-nats

**next-nats runs the Vercel platform features your Next.js app depends on, on a NATS server you operate.** It brings Redis, KV, Blob, Queues, Edge Config, the Data Cache and Cron Jobs to self-hosted Next.js through NATS and JetStream.

**Each subpath mirrors the API of the package Vercel promotes, so moving an app off Vercel means changing import specifiers, not application code.** `withNats` performs that swap at build time, so one codebase builds for Vercel or for your own infrastructure. Every Next.js replica connects to the same `nats-server` and shares cache, storage and queue state.

**Self-hosting Next.js usually means giving up the managed services the app was written against, or stitching together Redis, S3, a queue and a cron daemon to replace them.** A single NATS deployment covers all of them with one connection, one set of credentials and one thing to operate. Differential tests run the real Vercel and Upstash clients side by side with these implementations to keep the behavior matched.

**It is for teams that want to run Next.js on their own servers, containers or Kubernetes without rewriting code built for Vercel.** It also suits teams that already run NATS and want their web tier on the same messaging backbone, and anyone who wants to keep the option of deploying the same app to Vercel later.

For managed NATS infrastructure in production, we recommend <a href="https://synadia.com/?utm_source=trogonai&utm_medium=referral&utm_campaign=trogonai&utm_content=next-nats" rel="noopener"><img src="assets/synadia-logo.png" alt="Synadia" width="20" style="vertical-align: middle;"> Synadia</a>.

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

See the [documentation](./docs/README.md).
