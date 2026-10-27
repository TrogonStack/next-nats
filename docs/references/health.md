# Health

Route handler modules report process state. Readiness and liveness make no NATS call per probe and read the connection state the library already tracks. Diagnostics queries the server.

| Import | Exports | Probe |
| --- | --- | --- |
| `@trogonstack/next-nats/health/readiness` | `GET` | Readiness |
| `@trogonstack/next-nats/health/liveness` | `GET` | Liveness |
| `@trogonstack/next-nats/health/diagnostics` | `GET` | JSON diagnostics |
| `@trogonstack/next-nats/health` | `createDiagnosticsHandler`, `collectDiagnosticsBody`, `createReadinessHandler`, `createLivenessHandler`, `readinessChecks`, `livenessChecks`, `DEFAULT_READINESS_GRACE_MS`, `HealthCheck`, `ReadinessOptions`, `LivenessOptions` | Custom options |

## Mounting

```ts
// app/-/readiness/route.ts
export { GET } from "@trogonstack/next-nats/health/readiness";
```

```ts
// app/-/liveness/route.ts
export { GET } from "@trogonstack/next-nats/health/liveness";
```

## Checks

| Probe | Check | Passes when |
| --- | --- | --- |
| Readiness | `shutdown` | The process is not shutting down |
| Readiness | `connection` | Connected, or reconnecting for no longer than the grace period (`graceMs`, default 5 seconds) |
| Liveness | `initialization` | The connection is not stuck initializing |

## Response

Status `200` with body `ok` when every check passes, otherwise `503` with `not ready` or `not alive`. Add `?verbose` to list each check as `name: pass` or `name: fail`. Responses are `text/plain` and `no-store`.

## Diagnostics

`GET` from `@trogonstack/next-nats/health/diagnostics`, or `createDiagnosticsHandler(options)`, returns JSON with `cache-control: no-store`. Status is `200` when connected and `503` otherwise. It never opens a connection.

| Field | Meaning |
| --- | --- |
| `connected`, `status` | Connection phase |
| `server` | Server in use |
| `auth.mode` | `none`, `creds`, `credsFile`, `jwt`, `bearer`, `nkey`, `nkeyFile`, `token` or `userpass`. Never includes identities or secrets |
| `rttMs` | Round trip time, `null` when unavailable |
| `jetstream` | `{ available, streams, consumers, memory, storage }`, or `{ available: false }` |
| `diagnostics` | Sections registered with `registerDiagnostics` |

| Option | Meaning | Default |
| --- | --- | --- |
| `rttTimeoutMs` | Longest wait for the round trip | `2000` |

The route exposes server state, so protect it the same way as other operational endpoints.

```ts
// app/-/diagnostics/route.ts
export { GET } from "@trogonstack/next-nats/health/diagnostics";
```
