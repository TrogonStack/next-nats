# Cache with use cache and ISR

Share `'use cache'` entries, ISR pages and fetch cache entries across replicas.

## Enable the handlers

```ts
// next.config.ts
import { withNats } from "next-nats/next";

export default withNats({ cacheComponents: true }, { cache: true });
```

Pass options to tune the handlers:

```ts
withNats(
  { cacheComponents: true },
  { cache: { namespace: "shop", ttl: 7 * 24 * 60 * 60 * 1000, lruBytes: 32 * 1024 * 1024, replicas: 3 } },
);
```

Each option maps to a `NEXT_NATS_CACHE_*` variable, listed in the [configuration reference](../references/configuration.md).

## Cache and invalidate

Use the standard Next.js APIs. Entries and tags are shared, so an invalidation on one replica reaches the others.

```tsx
async function Price() {
  "use cache";
  cacheTag("price");
  cacheLife({ stale: 5, revalidate: 300, expire: 3600 });
  return <p>{await loadPrice()}</p>;
}
```

```ts
"use server";
import { updateTag } from "next/cache";

export async function refresh() {
  updateTag("price");
}
```

## Follow the rules for cacheComponents

- Remove route segment config such as `export const dynamic`.
- Run request-time NATS work under `await connection()` inside `<Suspense>`, or inside a `'use cache'` function.
- Call `await connection()` first in route handlers that touch NATS.

## Check coherency

`mise run demo:verify-cache` runs two replicas and checks both cache paths. [Cache coherency](../explanations/cache-coherency.md) explains how it works.
