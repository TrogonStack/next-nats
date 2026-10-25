# Edge Config

Exports of `@trogonstack/next-nats/edge-config`. The names, signatures and types of the read API match `@vercel/edge-config@1.5.1`, and a parity test checks them.

| Export | Description |
| --- | --- |
| `get(key, options?)` | Value or `undefined` |
| `getAll(keys?, options?)` | All items, or the listed keys |
| `has(key, options?)` | Whether the key exists |
| `digest(options?)` | Content hash of all items |
| `createClient(connectionString, options?)` | Client with `connection`, `get`, `getAll`, `has`, `digest`, plus `close()` |
| `parseConnectionString(text)` | `Connection` or `null` |
| `clone(value)` | Mutable deep copy |
| `setTracerProvider(provider)` | Accepted, does nothing |
| `updateEdgeConfigItems(connectionString, { items })` | Apply `create`, `update`, `upsert` and `delete` operations in order. Resolves `{ status: "ok" }` |
| `EdgeConfigError` | Thrown on conflicting writes |

Types: `EdgeConfigClient`, `EdgeConfigClientOptions`, `EdgeConfigFunctionsOptions`, `EdgeConfigValue`, `EdgeConfigItems`, `EmbeddedEdgeConfig`, `Connection`, `EdgeConfigItemOperation`.

## Connection string

`edge-config:id=<bucket>`, with optional `token` and `version` parameters that are carried into `connection` and otherwise unused. The default client reads `EDGE_CONFIG`, falling back to `NEXT_NATS_EDGE_CONFIG_BUCKET`.

## Options

`options.consistentRead` bypasses the in-process mirror and reads the bucket. `staleIfError`, `disableDevelopmentCache` and `cache` exist for type compatibility and are ignored. Values are JSON, and reads return copies the caller may mutate.

Errors for a missing or invalid connection string and for non string keys use the message text of `@vercel/edge-config`.
