# Getting started

By the end of this lesson you have a local NATS server, the demo app running against it, and proof that two Next.js replicas share one cache.

## Prerequisites

- Docker, to run `nats-server` with JetStream.
- [mise](https://mise.jdx.dev/), which provides Node.js and runs the repository tasks.

## Start NATS

```sh
mise run compose:up
```

This starts the `next-nats` compose project. The server is reachable as `nats://localhost:4222`, or as `nats://nats.next-nats.orb.local:4222` under OrbStack. The tasks default to the OrbStack hostname. Set `NATS_URL` to override it.

## Install and build

```sh
mise run install
mise run build
```

The demo imports `@trogonstack/next-nats` from the workspace, so the library is built first.

## Run the demo

```sh
mise run demo:start
```

Open <http://localhost:3000>. Each page exercises one primitive: KV, Blob, Queue, Edge Config, cache, rate limiting, realtime, services and cron. The task sets `NATS_WORKERS=true`, which starts the queue consumers and cron in that process.

## Prove two replicas agree

```sh
mise run demo:verify-cache
```

The task starts two `next start` processes against the same NATS server, reads a cached value from each, invalidates the tag on one and confirms the other replica stops serving the old value. It prints `OK` when both the `'use cache'` path and the fetch cache path behave.

## Wire it into your own app

```ts
// next.config.ts
import { withNats } from "@trogonstack/next-nats/next";

export default withNats({ cacheComponents: true }, { cache: true });
```

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNats } = await import("@trogonstack/next-nats/instrumentation");
    await registerNats({ setup: () => import("./services/nats/consumers") });
  }
}
```

Set `NATS_URL`, then pick a primitive from the [how-to guides](../how-tos/README.md).

## Stop NATS

```sh
mise run compose:down
```

The data volume is kept, so the next `compose:up` finds the same buckets and streams.
