# Health

Two route handler modules report process state for orchestrator probes. Neither makes a NATS call per probe; both read the connection state the library already tracks.

| Import | Exports | Probe |
| --- | --- | --- |
| `next-nats/health/readiness` | `GET` | Readiness |
| `next-nats/health/liveness` | `GET` | Liveness |
| `next-nats/health` | `createReadinessHandler`, `createLivenessHandler`, `readinessChecks`, `livenessChecks`, `DEFAULT_READINESS_GRACE_MS`, `HealthCheck`, `ReadinessOptions`, `LivenessOptions` | Custom options |

## Mounting

```ts
// app/-/readiness/route.ts
export { GET } from "next-nats/health/readiness";
```

```ts
// app/-/liveness/route.ts
export { GET } from "next-nats/health/liveness";
```

## Checks

| Probe | Check | Passes when |
| --- | --- | --- |
| Readiness | `shutdown` | The process is not shutting down |
| Readiness | `connection` | Connected, or reconnecting for no longer than the grace period (`graceMs`, default 5 seconds) |
| Liveness | `initialization` | The connection is not stuck initializing |

## Response

Status `200` with body `ok` when every check passes, otherwise `503` with `not ready` or `not alive`. Add `?verbose` to list each check as `name: pass` or `name: fail`. Responses are `text/plain` and `no-store`.
