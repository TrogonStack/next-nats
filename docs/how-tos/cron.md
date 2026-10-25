# Schedule cron jobs

Run a handler on a schedule exactly once across all replicas.

```ts
import { defineCron } from "next-nats/cron";

defineCron({
  name: "heartbeat",
  schedule: "* * * * *",
  timezone: "UTC",
  handler: ({ scheduledAt, replica }) => {
    console.log("tick", scheduledAt.toISOString(), replica);
  },
});
```

Define jobs in the module loaded by `registerNats`, on processes where `NATS_WORKERS=true`. Names may contain letters, digits, `_` and `-`.

## Tune retries

`maxDeliver`, `retryDelayMs`, `timeoutMs`, `maxLatenessMs` and `concurrency` control retries, the handler deadline, how late a tick may still run and parallel runs. A tick older than `maxLatenessMs` is skipped.

## Trigger by hand

```ts
import { triggerCron } from "next-nats/cron";

const { duplicate } = await triggerCron("heartbeat");
```

`duplicate` is true when that tick was already published.

## List recent runs

```ts
import { listCronRuns } from "next-nats/cron";

const runs = await listCronRuns();
```

Set `record: false` on a job to skip run history. [Cron deduplication](../explanations/cron-deduplication.md) explains the guarantee.
