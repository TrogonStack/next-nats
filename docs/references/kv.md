# KV

Exports of `@trogonstack/next-nats/kv`, shaped like `@vercel/kv` 3.0.0. Parity is checked by `packages/next-nats/tests/vitest/kv.parity.test.ts`.

| Export | Description |
| --- | --- |
| `kv` | Default `VercelKV` instance on the bucket from `NEXT_NATS_KV_BUCKET` (default `kv`) |
| `createClient(config)` | Build a `VercelKV`. `config.bucket` selects another bucket; Upstash connection fields are ignored |
| `VercelKV` | Extends the [Redis](./redis.md) client |
| default export | The `kv` instance |

`VercelKV` adds `scanIterator`, `hscanIterator`, `sscanIterator` and `zscanIterator`, which return async iterators over the matching `scan` family command.

Every command, the pipeline behavior and the semantic differences are in the [Redis reference](./redis.md).

The key encoding helpers `encodeKey` and `decodeKey` and the `KvStore` class remain exported for NATS specific use.
