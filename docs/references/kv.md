# next-nats/kv

A client shaped like `@vercel/kv` and the Upstash Redis client, stored in a NATS KV bucket.

```ts
import { kv, createKv } from "next-nats/kv";

await kv.set("user:1", { name: "ada" }, { ex: 60 });
await kv.incr("hits");
await kv.hset("session:1", { theme: "dark" });
```

`kv` uses the bucket from `NEXT_NATS_KV_BUCKET` (default `kv`). `createKv({ bucket })` targets another one. The bucket is created on first use with per-message TTL enabled.

## How commands map

- Each Redis key is one NATS KV key. Keys are encoded reversibly: letters, digits, `_`, `-` and `/` are kept, a `:` between two segments becomes `.` (so `user:1:name` is the subject token path `user.1.name`), and every other byte becomes `=XX`.
- Values are JSON. A record holds the type (`string` or `hash`), the value and an optional expiry.
- Every read-modify-write (`incr*`, `set` with `nx`/`xx`/`get`/`keepTtl`, `expire*`, `getdel`, all hash writes) is a compare-and-set on the key revision with a bounded retry loop, so concurrent callers never lose updates.
- Expiry is stored with millisecond precision in the record and enforced on read. When the bucket allows it, the server also gets a per-message TTL (whole seconds, rounded up) so expired keys are removed from storage.
- A plain `set` without conditions is a single publish and does not read first.

## Supported

Strings: `get set setnx setex psetex getset getdel mget mset del unlink exists incr incrby decr decrby incrbyfloat type`.
Expiry: `expire pexpire expireat pexpireat ttl pttl persist` (with `NX XX GT LT`).
Keyspace: `keys scan dbsize flushdb`.
Hashes: `hset hsetnx hget hmget hgetall hdel hincrby hexists hkeys hvals hlen`.

## Not supported

- Lists, sets, sorted sets, streams, bitmaps, HyperLogLog and geo commands.
- Pipelines, `multi`/`exec`, Lua scripting, pub/sub through this client, `watch`.
- `append`, `strlen`, `rename`, `copy`, `msetnx`, `hscan`, `randomkey`, `object`.
- Cross-key atomicity. Every operation is atomic for one key only; `mset` and multi-key `del` are not transactional.

## Semantic differences

- `scan` pages over the sorted key list by position, so keys created during iteration may be missed or repeated. `keys` and `scan` list every key in the bucket and are not meant for large buckets.
- Hashes are one record, so a hash is bounded by the bucket max value size (1 MiB by default) and every field write rewrites the whole hash.
- Values must be JSON serializable. `undefined` is rejected, store `null` instead. Numbers read back as numbers, never as strings.
- Sub-second `px` expiry is exact for reads but the server removes the entry on whole-second boundaries.
- An existing bucket created without per-message TTL keeps working through read-time expiry only; expired records then stay in storage until overwritten or deleted.
