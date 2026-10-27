# Connect to Synadia Cloud

Set the region preset and your credentials. The preset fills in the TLS server URLs and the WebSocket URLs for that region.

```sh
NATS_SYNADIA=true
NATS_CREDS=/run/secrets/synadia.creds
```

On Vercel, where there is no file system, pass the creds inline:

```sh
NATS_CREDS="data:;base64,$(base64 < synadia.creds | tr -d '\n')"
```

`true` selects the `global` region. Use a region name for a specific one: `eu`, `us`, `asia`, `west.us` or `east.us`.

In code:

```ts
import { configureNats, natsConfigFromEnv } from "@trogonstack/next-nats";

configureNats({ synadia: { region: "eu" }, auth: { kind: "credsFile", path: "/run/secrets/synadia.creds" } });
```

Code configuration never reads the environment. To keep the environment and change one field, spread it:

```ts
configureNats({ ...natsConfigFromEnv(), synadia: { region: "eu" } });
```

An explicit `servers` or `wsServers` value (or `NATS_URL`, `NATS_WS_SERVERS`) replaces the preset for that transport only.

On Bun and the Edge runtime the default `auto` transport uses the WebSocket URLs. Force one with `NATS_TRANSPORT=tcp` or `ws`.

Synadia Cloud rejects any stream, key value bucket or object store created without a byte limit (`10113 account requires a stream config to have max bytes set`). The preset therefore sets `streamMaxBytes` to 128 MiB, and next-nats applies it to every resource it creates. Free accounts have 2.5 GiB of disk across a small number of streams, and the server may reserve the limit against that disk, so the default stays modest. Raise or lower it with `NATS_STREAM_MAX_BYTES=512MiB` or `configureNats({ synadia: true, streamMaxBytes: "512MiB" })`.

The limit applies only when a resource is created. An existing stream keeps its limit, so changing the value never shrinks it. Set `maxBytes` on a stream spec to change one on purpose.

Free accounts allow only a handful of streams, and every key value bucket and Object Store is one. next-nats creates each one on first use, and the queue worker and `defineConsumer` wait for their stream instead of creating it. A starting app owns the cron stream and nothing else, a rendered page adds the cache bucket, and each capability adds its own (`kv`, Edge Config, blob, queue, rate limiting). Count what the app uses against the account limit before turning everything on. Connections are limited too, and so are subscriptions per connection (50 on free accounts): every service instance, cache watcher and queue consumer holds some, and a connection at the limit silently fails further subscriptions, which shows up as a stream that never delivers. The `limits` compose profile runs a local server capped like a free account, see [Run the repository tasks](./repository-tasks.md).

Accounts without JetStream still connect. Use `getJsIfAvailable()` to check before using streams.
