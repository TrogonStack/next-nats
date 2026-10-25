# Health

`checkHealth()` from `next-nats/health` resolves a `HealthReport`:

| Field | Meaning |
| --- | --- |
| `status` | `connected` or `disconnected` |
| `servers` | Configured server URLs |
| `server` | `id`, `name`, `version`, `host`, `port` when connected |
| `rttMs` | Round trip time to the server |
| `jetstream` | `memory`, `storage`, `streams`, `consumers` |
| `error` | Failure message when disconnected |

Expose it from a route handler that calls `await connection()` first.
