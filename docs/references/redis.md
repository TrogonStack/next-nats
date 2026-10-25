# Redis

Exports of `@trogonstack/next-nats/redis`, shaped like `@upstash/redis` 1.39.0. Parity is checked by `packages/next-nats/tests/vitest/redis.parity.test.ts`.

## Constructor

`new Redis(config)` accepts the Upstash `RedisConfigNodejs` fields. `url`, `token`, `retry`, `agent`, `signal`, `keepAlive`, `latencyLogging`, `readYourWrites` and `enableTelemetry` are accepted and ignored. `automaticDeserialization` (default `true`) is honored. `bucket` is an extra field that selects the NATS KV bucket; it defaults to `NEXT_NATS_KV_BUCKET`, then `kv`.

`Redis.fromEnv(config?)` builds a client from the same environment variable.

## Storage model

- Each key is one NATS KV key. Keys are encoded reversibly: letters, digits, `_`, `-` and `/` are kept, a `:` between two segments becomes `.`, and every other byte becomes `=XX`.
- Strings are stored raw when they are strings and as JSON otherwise, matching Upstash serialization. Reads parse JSON when `automaticDeserialization` is on.
- Hashes, lists, sets and sorted sets are one record per key. Collections are bounded by the bucket max value size, and every write rewrites the whole record. Empty collections are deleted.
- Every read-modify-write is a compare-and-set on the key revision with a bounded retry loop, so concurrent callers do not lose updates. Exhausting the retries raises `UpstashError`.
- Expiry has millisecond precision and is enforced on read. The server also gets a native per-message TTL in whole seconds.

## Supported commands

Strings: `get set setnx setex psetex getset getdel getex mget mset msetnx append strlen getrange setrange incr incrby incrbyfloat decr decrby`.

Keys: `del unlink exists touch expire pexpire expireat pexpireat persist ttl pttl type rename renamenx copy keys scan randomkey dbsize flushdb flushall`.

Server: `ping echo time`.

Hashes: `hset hmset hsetnx hget hgetall hmget hgetdel hdel hincrby hincrbyfloat hexists hkeys hvals hlen hstrlen hrandfield hscan`.

Lists: `lpush rpush lpushx rpushx lpop rpop llen lindex lrange lset lrem ltrim linsert lmove lpos`.

Sets: `sadd srem sismember smismember smembers scard spop srandmember smove sdiff sdiffstore sinter sinterstore sunion sunionstore sintercard sscan`.

Sorted sets: `zadd zcard zcount zlexcount zincrby zscore zmscore zrank zrevrank zrem zrange zpopmin zpopmax zremrangebyrank zremrangebyscore zremrangebylex zunion zunionstore zinterstore zdiffstore zscan`.

Batching: `pipeline()` and `multi()`.

## Pipelines

Both return a chainable object with every command above plus `exec()` and `length()`. `exec()` resolves the results in order and throws on the first failed command. `exec({ keepErrors: true })` resolves `{ error?, result }` entries instead.

`multi()` is not atomic: commands run one after another and other clients can interleave. Each command is still individually atomic.

## Unsupported

These throw `UnsupportedCommandError`, or are absent:

- `eval`, `evalRo`, `evalsha`, `evalshaRo`, `scriptLoad`, `scriptExists`, `scriptFlush` and `createScript`. NATS KV has no server-side scripting.
- JSON, search, vector, streams, geo, bitmap, HyperLogLog and pub/sub commands.
- Per-field hash expiry and `hgetex`/`hsetex`, `lmpop` and other less common variants.

## Semantic differences

- Multi-key commands (`mset`, `msetnx`, `rename`, `smove`, `lmove`, `*store`, multi-key `del`) are not transactions.
- `scan` and the `*scan` commands page by position over a sorted listing, so concurrent writes may be missed or repeated. `keys` and `scan` list the whole bucket and are not meant for large buckets.
- Random commands (`randomkey`, `hrandfield`, `srandmember`, `spop`) use a local random source.

## Errors

`errors.UpstashError`, `errors.UrlError`, `errors.UpstashJSONParseError` and `errors.UnsupportedCommandError`. Wrong-type access raises `UpstashError` with a `WRONGTYPE` message.
