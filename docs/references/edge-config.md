# Edge Config

Exports of `next-nats/edge-config`.

| Export | Description |
| --- | --- |
| `get(key, options?)` | Value or `undefined` |
| `getAll(keys?, options?)` | All items, or the listed keys |
| `has(key, options?)` | Whether the key exists |
| `digest(options?)` | Content hash of all items |
| `createClient({ bucket })` | Client with the same methods plus `bucket` and `close()` |
| `setEdgeConfigItems(items, options?)` | Apply `create`, `update`, `upsert` and `delete` operations in order |
| `EdgeConfigError` | Thrown on conflicting writes |

`options.consistentRead` bypasses the in-process mirror and reads the bucket. Values are JSON. Types: `EdgeConfigValue`, `EdgeConfigItems`, `EdgeConfigItemOperation`.

The bucket is `NEXT_NATS_EDGE_CONFIG_BUCKET`, default `edge-config`.
