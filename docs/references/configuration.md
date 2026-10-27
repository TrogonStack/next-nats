# Configuration

Configuration is explicit. The environment and code are two separate sources that are never mixed field by field.

| Function | Reads |
| --- | --- |
| `natsConfigFromEnv(env?)` | The whole config from the variables below. `env` defaults to `process.env` |
| `natsConfig(input?)` | The whole config from `input` and built-in defaults. It never reads the environment |

When nothing was configured, the first connection uses `natsConfigFromEnv()`. `configureNats(input)`, `connectNats(input)` and `registerNats({ config })` take a `NatsConfigInput` and run it through `natsConfig`, so a field left out takes its default, not an environment value. To override one thing and keep the rest of the environment, spread the environment config:

```ts
configureNats({ ...natsConfigFromEnv(), auth: { kind: "token", token: "..." } });
```

The variable names follow the official `nats` CLI where it has an equivalent.

## Connection

| Variable | Meaning | Default |
| --- | --- | --- |
| `NATS_URL` | Comma separated server URLs | `nats://127.0.0.1:4222` |
| `NATS_WS_SERVERS` | Comma separated WebSocket URLs, used when the transport is `ws` | `NATS_URL` |
| `NATS_TRANSPORT` | `auto`, `tcp` or `ws`. `auto` selects `ws` on Bun and the Edge runtime and `tcp` elsewhere | `auto` |
| `NATS_NAME` | Connection name | `next-nats@<hostname>:<pid>` |
| `NATS_SYNADIA` | `true` or a region (`global`, `eu`, `us`, `asia`, `west.us`, `east.us`) to point at Synadia Cloud. See [Connect to Synadia Cloud](../how-tos/synadia-cloud.md) | unset |
| `NATS_JS_DOMAIN` | JetStream domain. Mutually exclusive with `NATS_JS_API_PREFIX` | unset |
| `NATS_JS_API_PREFIX` | JetStream API prefix. Mutually exclusive with `NATS_JS_DOMAIN` | unset |
| `NATS_STREAM_MAX_BYTES` | Byte limit applied to every stream, key value bucket and object store next-nats creates when its own option is not given. A size such as `128MiB` or `1GiB`, or bytes. Not a `nats` CLI variable. Only applies when a resource is created, never to one that exists | no limit, or `128MiB` when `NATS_SYNADIA` is set |
| `NATS_WORKERS` | `true` or `1` starts consumers, services and crons in this process | `false` |
| `NATS_TIMEOUT` | Connect timeout | `10s` |
| `NATS_MAX_RECONNECT_ATTEMPTS` | `-1` is unlimited | `-1` |
| `NATS_RECONNECT_TIME_WAIT` | Time between reconnects | `2s` |
| `NATS_DRAIN_TIMEOUT` | Time allowed to drain on shutdown | `10s` |

Durations accept Go style text such as `5s`, `500ms` or `1m30s`. A bare integer is milliseconds. In code, `timeout`, `reconnectTimeWait` and `drainTimeout` accept a `Duration`, text or milliseconds.

Sizes accept `B`, decimal units (`KB`, `MB`, `GB`, `TB`) and binary units (`KiB`, `MiB`, `GiB`, `TiB`). A bare integer is bytes. In code, `streamMaxBytes` accepts a `ByteSize`, text or bytes, and a capability option such as the key value `maxBytes` or a stream `maxBytes` overrides it. An explicit `-1` on a stream spec (`max_bytes`) keeps that stream unlimited.

## Authentication

Set one of `NATS_USER`, `NATS_CREDS`, `NATS_NKEY` or `NATS_JWT`, following the `nats` CLI context rules. Setting more than one fails with `MULTIPLE_AUTH` ("too many types of credentials, choose only one of user, creds, nkey, jwt"), so a stale variable never silently wins. The order of the kinds in code is `userpass`, then `creds`, `nkey`, `jwt`, `bearer`.

| Variable | Auth kind |
| --- | --- |
| `NATS_USER` with `NATS_PASSWORD` | `userpass` |
| `NATS_CREDS` | `credsFile` for a path, `creds` for an inline value. A path is read again on every reconnect |
| `NATS_NKEY` | `nkeyFile` for a path, `nkey` for an inline value. The location resolves to a seed |
| `NATS_JWT` with `NATS_SEED` | `jwt`: a user JWT signed with the seed |
| `NATS_JWT` | `bearer`: a user JWT with no seed |
| `NATS_TOKEN` | `token` alone, or added to the credential above |

`NATS_TOKEN` is applied in addition to the credential, independent of the choice. `NATS_SEED` without `NATS_JWT` and `NATS_PASSWORD` without `NATS_USER` are rejected.

### Location values

`NATS_CREDS` and `NATS_NKEY` are locations:

| Value | Meaning |
| --- | --- |
| `/path/to/file` | A file path |
| `file:///path/to/file` | A file path |
| `data:[<mediatype>];base64,<payload>` | The inline value. `;base64` is required, plain `data:` is rejected |
| `env://NAME` | The value of the environment variable `NAME` |
| Any other `scheme://` | Rejected with `INVALID_ARGUMENT` naming the scheme |

`NATS_JWT`, `NATS_SEED`, `NATS_TOKEN` and `NATS_PASSWORD` are literals. They are resolved only when they start with `file://`, `data:` or `env://`, and trailing line breaks are trimmed from the resolved value. `NATS_CERT`, `NATS_KEY` and `NATS_CA` are paths only.

On Vercel there is no file system, so pass credentials inline:

```sh
NATS_CREDS="data:;base64,$(base64 < nats.creds | tr -d '\n')"
```

With none set the connection is unauthenticated.

When a JWT or creds expiry is known at connect time, the library logs a warning if it is less than 24 hours away and fails with `CredentialsExpiredError` if it has passed. Authentication failures are logged with an `AUTH ERROR` prefix and never include secret values.

## Secrets

Secret variables accept the plain value or the Secret Value Syntax `secret:[nid]:[nss]:[value]`, where the value is used and the rest is a label. Parsed secrets are held in the `Secret` value object exported from `@trogonstack/next-nats`: `Secret.parse` and `Secret.of` create one, `reveal()` returns the value, and `toString`, `toJSON` and inspection print `[REDACTED]`. `examples/demo/.env.example` shows each variable.

## TLS

| Variable | Meaning |
| --- | --- |
| `NATS_TLS` | `true` requires TLS |
| `NATS_CA` | CA certificate path |
| `NATS_CERT` | Client certificate path |
| `NATS_KEY` | Client key path |
| `NATS_TLS_FIRST` | Handshake before the server info |
| `NATS_TLS_REJECT_UNAUTHORIZED` | Set `false` to accept unverified certificates |

## Buckets

| Variable | Meaning | Default |
| --- | --- | --- |
| `NEXT_NATS_KV_BUCKET` | Bucket behind `kv` | `kv` |
| `NEXT_NATS_BLOB_BUCKET` | Object Store bucket for blobs | `next_nats_blob` |
| `BLOB_BASE_URL`, `NEXT_PUBLIC_BLOB_BASE_URL` | Blob route mount URL | `/blob` |
| `BLOB_SECRET`, `BLOB_READ_WRITE_TOKEN` | Blob signing secret, see [Blob](./blob.md) | required in production, random per process otherwise |
| `EDGE_CONFIG` | Edge Config connection string, `edge-config:id=<bucket>` | `edge-config:id=` plus `NEXT_NATS_EDGE_CONFIG_BUCKET` |
| `NEXT_NATS_EDGE_CONFIG_BUCKET` | Bucket used when `EDGE_CONFIG` is unset | `edge-config` |

## Cron

| Variable | Meaning | Default |
| --- | --- | --- |
| `CRON_SECRET` | Sent as `Authorization: Bearer` on `vercel.json` cron calls, as on Vercel | unset, no header |
| `NEXT_NATS_CRON_BASE_URL` | Base URL the `vercel.json` cron worker calls | `http://127.0.0.1:$PORT`, port `3000` |

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

`servers`, `wsServers`, `transport`, `name`, `auth` (one of `none`, `token`, `userpass`, `nkey`, `creds`, `credsFile`, `jwt`, `bearer`), `synadia`, `jsDomain`, `jsApiPrefix`, `tls`, `workers`, `timeout`, `maxReconnectAttempts`, `reconnectTimeWait` and `drainTimeout`, with durations in milliseconds. `NatsConfig` is plain data and can be spread. `NatsConfigInput` makes every field optional, accepts `servers` as a string or array, durations as `Duration`, text or milliseconds, and `synadia` as `true`, a region or `{ region }`. A `NatsConfig` is a valid `NatsConfigInput`.
