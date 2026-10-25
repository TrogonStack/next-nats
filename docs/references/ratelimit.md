# Rate limit

Exports of `next-nats/ratelimit`, shaped like `@upstash/ratelimit`.

## Ratelimit

`new Ratelimit({ limiter, kv?, prefix? })`. `kv` defaults to the shared `kv` client and `prefix` to `ratelimit`.

| Member | Description |
| --- | --- |
| `limit(identifier, { rate? })` | Consume `rate` tokens (default `1`). Resolves `{ success, limit, remaining, reset, pending }` |
| `blockUntilReady(identifier, timeout)` | Retry until success or the timeout |
| `getRemaining(identifier)` | Current `{ remaining, reset, limit }` without consuming |
| `resetUsedTokens(identifier)` | Forget the identifier's state |
| `Ratelimit.fixedWindow(tokens, window)` | Counter per window |
| `Ratelimit.slidingWindow(tokens, window)` | Weighted previous and current window |
| `Ratelimit.tokenBucket(refillRate, interval, maxTokens)` | Refilling bucket |

`reset` is a millisecond timestamp. `pending` resolves immediately, kept for compatibility.

## Durations

`Duration` is `"<n> <unit>"` or `"<n><unit>"` with unit `ms`, `s`, `m`, `h` or `d`. `toMs` converts one.

## Storage

State is one KV record per identifier, updated with compare-and-set so concurrent callers do not lose counts. Records expire after twice the window, or the time to refill a full bucket.
