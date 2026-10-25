# Configuration

Configuration is read from the environment and can be overridden in code with `configureNats` or `registerNats({ config })`.

## Connection

| Variable | Meaning | Default |
| --- | --- | --- |
| `NATS_SERVERS` | Comma separated server URLs | `nats://127.0.0.1:4222` |
| `NATS_TRANSPORT` | `tcp` or `ws` | `tcp` |
| `NATS_NAME` | Connection name | unset |
| `NATS_WORKERS` | `true` or `1` starts consumers, services and crons in this process | `false` |
| `NATS_TIMEOUT` | Connect timeout in milliseconds | `10000` |
| `NATS_MAX_RECONNECT_ATTEMPTS` | `-1` is unlimited | `-1` |
| `NATS_RECONNECT_TIME_WAIT` | Milliseconds between reconnects | `2000` |
| `NATS_DRAIN_TIMEOUT` | Milliseconds allowed to drain on shutdown | `10000` |

## Authentication

The first match wins, in this order.

| Variable | Auth kind |
| --- | --- |
| `NATS_CREDS` | `creds`: a creds file, raw or base64 |
| `NATS_CREDS_FILE` | `credsFile`: path to a creds file |
| `NATS_NKEY_SEED` | `nkey` |
| `NATS_TOKEN` | `token` |
| `NATS_USER`, `NATS_PASS` | `userpass` |

With none set the connection is unauthenticated.

## Secrets

Secret variables accept the plain value or the Secret Value Syntax `secret:[nid]:[nss]:[value]`, where the value is used and the rest is a label. Parsed secrets are held in the `Secret` value object exported from `@trogonstack/next-nats`: `Secret.parse` and `Secret.of` create one, `reveal()` returns the value, and `toString`, `toJSON` and inspection print `[REDACTED]`. `examples/demo/.env.example` shows each variable.

## TLS

| Variable | Meaning |
| --- | --- |
| `NATS_TLS` | `true` requires TLS |
| `NATS_TLS_CA_FILE` | CA certificate path |
| `NATS_TLS_CERT_FILE` | Client certificate path |
| `NATS_TLS_KEY_FILE` | Client key path |
| `NATS_TLS_HANDSHAKE_FIRST` | Handshake before the server info |
| `NATS_TLS_REJECT_UNAUTHORIZED` | Set `false` to accept unverified certificates |

## Buckets

| Variable | Meaning | Default |
| --- | --- | --- |
| `NEXT_NATS_KV_BUCKET` | Bucket behind `kv` | `kv` |
| `NEXT_NATS_BLOB_BUCKET` | Object Store bucket for blobs | see [Blob](./blob.md) |
| `NEXT_NATS_EDGE_CONFIG_BUCKET` | Edge Config bucket | `edge-config` |

## Cache

Set through `withNats(config, { cache: { ... } })`, which writes the variables for the handlers.

| Option | Variable | Meaning | Default |
| --- | --- | --- | --- |
| `namespace` | `NEXT_NATS_CACHE_NAMESPACE` | Prefix of the cache buckets | `next_cache` |
| `ttl` | `NEXT_NATS_CACHE_TTL_MS` | Entry lifetime in milliseconds, `0` disables | 30 days |
| `lruBytes` | `NEXT_NATS_CACHE_LRU_BYTES` | In-memory front cache size | 64 MiB |
| `inlineLimit` | `NEXT_NATS_CACHE_INLINE_LIMIT` | Largest body kept in a KV entry before moving to the Object Store | derived from the server max payload |
| `replicas` | `NEXT_NATS_CACHE_REPLICAS` | JetStream replicas for the cache buckets | `1` |

## Shape of NatsConfig

`servers`, `transport`, `name`, `auth` (one of `none`, `token`, `userpass`, `nkey`, `creds`, `credsFile`), `tls`, `workers`, `timeout`, `maxReconnectAttempts`, `reconnectTimeWait` and `drainTimeout`. `NatsConfigInput` makes every field optional and accepts `servers` as a string or array.
