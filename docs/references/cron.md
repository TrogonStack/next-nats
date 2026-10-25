# Cron

Exports of `@trogonstack/next-nats/cron`.

| Export | Description |
| --- | --- |
| `defineCron(definition)` | Register a job on the default runtime. Returns a `CronJob` |
| `triggerCron(name, at?)` | Publish a tick. Resolves `{ duplicate }` |
| `stopAllCrons()` | Stop every job |
| `createCronRuntime(options?)` | Independent runtime. Options: `stream` (`CRON`), `prefix` (`cron`), `duplicateWindowMs` (five minutes), `replica` |
| `nextOccurrence(schedule, from, timezone?)`, `validateSchedule` | Schedule helpers |
| `listCronRuns({ name?, limit? })`, `recordCronRun(run)` | Run history, newest first, default limit `20` |

## Definition

| Field | Meaning | Default |
| --- | --- | --- |
| `name` | Letters, digits, `_`, `-` | required |
| `schedule` | Cron expression | required |
| `timezone` | IANA zone | process zone |
| `handler(context)` | Work to run | required |
| `timeoutMs` | Handler deadline | five minutes |
| `maxDeliver` | Attempts | `3` |
| `retryDelayMs` | Delay before a retry | `5000` |
| `maxLatenessMs` | Ticks older than this are skipped | five minutes |
| `concurrency` | Parallel ticks | `1` |
| `record` | Write run history | `true` |
| `onError` | Receives handler and loop failures | none |

The context holds `name`, `scheduledAt`, `deliveryCount`, `replica` and an `AbortSignal` that fires on timeout or shutdown.

## CronJob

`name`, `schedule`, `nextRun(from?)`, `trigger(at?)`, `stop()`.

## CronRun

`name`, `scheduledAt`, `startedAt`, `finishedAt`, `status` (`success`, `failed` or `skipped`), `replica`, `deliveryCount`, `error?`. History lives in the `next_nats_cron` bucket for 24 hours.
