# Deploy the same app to Vercel or self-hosted

Write the app against the packages Vercel promotes, and let `withNats` decide at build time which implementation answers the imports.

## Write real imports

```ts
import { kv } from "@vercel/kv";
import { Ratelimit } from "@upstash/ratelimit";
import { put } from "@vercel/blob";
import { upload } from "@vercel/blob/client";
import { get } from "@vercel/edge-config";
import { send } from "@vercel/queue";
```

Add those packages as dependencies at the versions listed in [entry points](../references/entry-points.md) so TypeScript checks the app against the real types.

## Configure withNats

```ts
import type { NextConfig } from "next";
import { withNats } from "@trogonstack/next-nats/next";

const nextConfig: NextConfig = { cacheComponents: true };

export default withNats(nextConfig, { cache: true });
```

## Build for each target

Self-hosted, where `VERCEL` is unset:

```sh
next build
next start
```

The specifiers are aliased to `@trogonstack/next-nats`, the cache handlers are installed and `vercel.json` is embedded. Set `NATS_SERVERS` and, for blob tokens, `BLOB_SECRET` at runtime.

On Vercel, which sets `VERCEL=1`, the build bundles the real packages and installs nothing from this package.

## Force a target

```ts
withNats(nextConfig, { platform: "self-hosted" });
```

Use `platform: "vercel"` to test the Vercel bundle locally and `platform: "self-hosted"` to run the NATS implementation while `VERCEL` is set, for example in a CI that mirrors Vercel's environment.

## Keep NATS-only features separate

Features without a Vercel counterpart keep importing `@trogonstack/next-nats`: realtime, services, raw publish, health, `defineCron`, `updateEdgeConfigItems` and `startQueueWorker`. They are not aliased, so gate them behind your own platform check when the same code must also build on Vercel.

## Cron and queue triggers

`vercel.json` `crons` are scheduled by `registerNats({ vercelCrons: true })` and queue triggers by `startQueueWorker()`. Both read the copy of `vercel.json` captured at build time, see [`withNats` options](../references/cache.md#withnats).
