# Architecture

next-nats gives a self-hosted Next.js deployment the platform primitives that Vercel provides as managed services. The only infrastructure is a `nats-server` with JetStream. Every Next.js replica connects to it and shares the state it holds.

## Layers

- **Core.** One lazily created connection per process, stored on `globalThis` so hot reloads and duplicated module graphs share it. Configuration comes from `NATS_*` variables. Helpers open KV and Object Store buckets once per process, and shutdown hooks drain the connection.
- **Primitives.** Each primitive is a module over the core. KV, Edge Config, rate limiting and the cache sit on KV buckets. Blob and large cache bodies sit on the Object Store. Queue, cron and consumers sit on JetStream streams. Services use NATS micro. Realtime uses core subscriptions and ordered consumers.
- **Next.js integration.** `withNats` installs the cache handlers and marks the NATS packages as server externals. `registerNats` connects at startup and loads the module that defines long-running work.

## Workers

Request handling and background work are separate concerns. Consumers, queue subscriptions, services and cron loops only start in a process where `NATS_WORKERS=true`. Replicas without the flag serve requests and can still publish, send and call services. This lets a deployment scale web replicas independently of the processes that do background work. The switch is per process and covers all kinds of background work together.

## Library shape

The package follows the surface of the Vercel packages it replaces where one exists (`@vercel/kv`, `@vercel/blob`, `@vercel/edge-config`, Vercel Queues, `@upstash/ratelimit`), so application code moves with an import change. Where no equivalent exists (realtime, services, cron) the API is its own.
