# Schedule cron jobs

Run a handler on a schedule exactly once across all replicas.

```ts
import { defineCron } from "@trogonstack/next-nats/cron";

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

## Run Vercel cron jobs

Keep the `crons` array in `vercel.json` and the route handlers you wrote for Vercel:

```json
{ "crons": [{ "path": "/api/cron/heartbeat", "schedule": "* * * * *" }] }
```

```ts
export async function GET(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return Response.json({ ok: true });
}
```

Turn the worker on in `registerNats`:

```ts
await registerNats({ vercelCrons: true });
```

On each schedule, one replica sends `GET` to the path with `User-Agent: vercel-cron/1.0`, `x-vercel-cron-schedule` and `Authorization: Bearer $CRON_SECRET`, exactly once across replicas. Set `CRON_SECRET` in the environment of the worker and the app. Set `NEXT_NATS_CRON_BASE_URL` to the address the worker should call, such as the load balancer in front of the app. Pass `{ configPath, baseUrl, secret, timeoutMs }` instead of `true` to override the defaults. It runs only where `NATS_WORKERS=true`.

## Tune retries

`maxDeliver`, `retryDelayMs`, `timeoutMs`, `maxLatenessMs` and `concurrency` control retries, the handler deadline, how late a tick may still run and parallel runs. A tick older than `maxLatenessMs` is skipped.

## Trigger by hand

```ts
import { triggerCron } from "@trogonstack/next-nats/cron";

const { duplicate } = await triggerCron("heartbeat");
```

`duplicate` is true when that tick was already published.

## List recent runs

```ts
import { listCronRuns } from "@trogonstack/next-nats/cron";

const runs = await listCronRuns();
```

Set `record: false` on a job to skip run history. [Cron deduplication](../explanations/cron-deduplication.md) explains the guarantee.
