# Rate limit

Exports of `@trogonstack/next-nats/ratelimit`, shaped like `@upstash/ratelimit` 2.2.0. Parity is checked by `packages/next-nats/tests/vitest/ratelimit.parity.test.ts`.

## Ratelimit

`new Ratelimit({ redis, limiter, prefix?, ephemeralCache?, timeout?, analytics?, dynamicLimits?, ... })`. `redis` is a [Redis](./redis.md) client or the `kv` instance. `prefix` defaults to `@upstash/ratelimit`, `timeout` to `5000` milliseconds and `ephemeralCache` to a new `Map`; pass `false` to disable it.

| Member | Description |
| --- | --- |
| `limit(identifier, { rate?, geo?, ip?, userAgent?, country? })` | Consume `rate` tokens (default `1`). Resolves `{ success, limit, remaining, reset, pending, reason? }` |
| `blockUntilReady(identifier, timeout)` | Retry until success or the timeout. Throws when `timeout` is not positive |
| `getRemaining(identifier)` | Current `{ remaining, reset, limit }` without consuming |
| `resetUsedTokens(identifier)` | Forget the identifier's state |
| `setDynamicLimit({ limit })` and `getDynamicLimit()` | Override the limit at runtime when `dynamicLimits` is on |
| `Ratelimit.fixedWindow(tokens, window)` | Counter per window |
| `Ratelimit.slidingWindow(tokens, window)` | Weighted previous and current window |
| `Ratelimit.tokenBucket(refillRate, interval, maxTokens)` | Refilling bucket |
| `Ratelimit.cachedFixedWindow(tokens, window)` | Fixed window that answers blocked identifiers from the ephemeral cache |

`reset` is a millisecond timestamp. When the timeout elapses first, `limit` resolves `{ success: true, limit: 0, remaining: 0, reset: 0, reason: "timeout" }`.

## Durations

`Duration` is `"<n> <unit>"` or `"<n><unit>"` with unit `ms`, `s`, `m`, `h`, `d` or `w`. `toMs` converts one.

## Analytics

`analytics: true` counts allowed and blocked requests per identifier. `Analytics.getUsage()` reads the totals. The time series methods throw `UnsupportedCommandError`.

## Counting

The algorithms count the way `@upstash/ratelimit` does. Fixed window and cached fixed window keep counting blocked requests, so `remaining` and `reset` match for the same request sequence. Sliding window and token bucket do not consume tokens for blocked requests. Cached fixed window can report a negative `remaining` once its local counter passes the limit. A negative `rate` refunds tokens.

## Storage

State is one KV record per identifier, updated with compare-and-set so concurrent callers do not lose counts. Records expire after twice the window, or the time to refill a full bucket.

## Differences

- `MultiRegionRatelimit`, `enableProtection`, `IpDenyList` updates and the `Analytics` time series throw `UnsupportedCommandError`.
- `enableTelemetry`, `cacheScripts` and `denyListThreshold` are accepted and ignored.
