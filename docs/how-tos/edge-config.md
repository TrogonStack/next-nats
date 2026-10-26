# Read Edge Config

Replace `@vercel/edge-config` with a KV bucket mirrored into process memory. Change the import specifier and keep the code.

```ts
import { get, getAll, has, digest, createClient } from "@trogonstack/next-nats/edge-config";

const flag = await get<boolean>("new-checkout");
const all = await getAll();
const client = createClient(process.env.EDGE_CONFIG);
```

Reads come from an in-process mirror kept current by a watcher, so they do not wait on the network. The first read waits for the mirror to catch up.

## Choose the bucket

Set `EDGE_CONFIG` to `edge-config:id=<bucket>`. When it is unset, the default client uses `NEXT_NATS_EDGE_CONFIG_BUCKET` (default `edge-config`). The NATS servers come from `NATS_SERVERS`.

## Read the latest value

```ts
await get("new-checkout", { consistentRead: true });
```

`consistentRead` bypasses the mirror and reads the bucket.

## Write items

The Vercel SDK has no writes. Vercel exposes them through a REST call that takes `items` with an `operation` of `create`, `update`, `upsert` or `delete`. This package offers the same shape as a function:

```ts
import { updateEdgeConfigItems } from "@trogonstack/next-nats/edge-config";

await updateEdgeConfigItems(process.env.EDGE_CONFIG, {
  items: [
    { operation: "upsert", key: "new-checkout", value: true },
    { operation: "delete", key: "old-banner" },
  ],
});
```

It resolves `{ status: "ok" }`. `create` fails when the key exists. `update` and `delete` fail when the key is missing, Failures throw `EdgeConfigError`. Keys must match `^[A-Za-z0-9_-]{1,256}$`. Every operation is checked against the current items and the whole batch is committed atomically against the revisions that were read. A concurrent writer makes the batch re-read, re-validate and retry, so a batch either applies completely or changes nothing.
