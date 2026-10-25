# Read Edge Config

Replace `@vercel/edge-config` with a KV bucket mirrored into process memory.

```ts
import { get, getAll, has, digest } from "@trogonstack/next-nats/edge-config";

const flag = await get<boolean>("new-checkout");
const all = await getAll();
```

Reads come from an in-process mirror kept current by a watcher, so they do not wait on the network. The first read waits for the mirror to catch up.

## Read the latest value

```ts
await get("new-checkout", { consistentRead: true });
```

`consistentRead` bypasses the mirror and reads the bucket.

## Write items

```ts
import { setEdgeConfigItems } from "@trogonstack/next-nats/edge-config";

await setEdgeConfigItems([
  { operation: "upsert", key: "new-checkout", value: true },
  { operation: "delete", key: "old-banner" },
]);
```

`create` fails when the key exists. `update` fails when the key is missing or changed concurrently.

## Choose the bucket

Set `NEXT_NATS_EDGE_CONFIG_BUCKET` (default `edge-config`) or call `createClient({ bucket })`.
