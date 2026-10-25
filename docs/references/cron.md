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

## Vercel crons

| Export | Description |
| --- | --- |
| `registerVercelCrons(options?)` | Define one job per `crons` entry of `vercel.json`. Returns the `CronJob` list |
| `readVercelCrons(configPath?)` | Parse and validate the `crons` array |
| `vercelCronName(cron)` | Job name derived from path and schedule |
| `VERCEL_CRON_USER_AGENT` | `vercel-cron/1.0` |

`VercelCronsOptions`:

| Option | Meaning | Default |
| --- | --- | --- |
| `configPath` | File with the `crons` array, relative to the working directory | `vercel.json` |
| `baseUrl` | Address called | `NEXT_NATS_CRON_BASE_URL`, else `http://127.0.0.1:$PORT` |
| `secret` | Bearer token | `CRON_SECRET`, read at call time |
| `timeoutMs` | Request deadline | five minutes |
| `runtime` | Cron runtime to use | default runtime |
| `fetch` | Request function | global `fetch` |

Each entry needs a `path` starting with `/`, which may carry a query string, and a five field `schedule`, evaluated in UTC. The call is a `GET` carrying `x-vercel-cron-schedule` with the entry schedule, and it does not follow redirects. Failed runs are not retried. A status of 400 or above is logged as a failure. A missing file yields no jobs.

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
