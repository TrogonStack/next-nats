# Run the repository tasks

Every routine action is a mise task.

| Task | Does |
| --- | --- |
| `mise run compose:up` | Start NATS with JetStream |
| `mise run compose:down` | Stop NATS and keep its data |
| `mise run install` | Install dependencies |
| `mise run build` | Build the library and the demo |
| `mise run typecheck` | Typecheck every package |
| `mise run test` | Run the tests against NATS |
| `mise run parity:redis` | Start Redis and its HTTP proxy, then run the Redis, KV and ratelimit differential suites |
| `mise run e2e:run` | Build the demo three ways and run the end-to-end suite |
| `mise run e2e:limits` | Run only the capped account suite |
| `mise run demo:dev` | Run the demo in development mode |
| `mise run demo:start` | Run the built demo |
| `mise run demo:verify-cache` | Check cache coherency across two replicas |
| `mise run parity:blob` | Compare `@trogonstack/next-nats/blob` with `@vercel/blob` |
| `mise run parity:edge-queue` | Run the Edge Config, queue and cron differential suites |
| `mise run ci` | Install, build, typecheck and test |

`NATS_URL` defaults to `nats://nats.next-nats.orb.local:4222` in these tasks. Export it to point somewhere else, or set `NEXT_NATS_COMPOSE_PROJECT` to run an isolated stack whose server is `nats://nats.<project>.orb.local:4222`.

The compose file lives at `devops/docker/compose/compose.yaml` and keeps the project name `next-nats`.

## Run the blob parity suite

`mise run parity:blob` runs the same scenarios through the real `@vercel/blob` against a local fake of the Vercel Blob service and through `@trogonstack/next-nats/blob` against NATS, then compares the results. The model test logs its seed. Set `BLOB_MODEL_SEED` to replay a run and `BLOB_MODEL_RUNS` to change its length. Set `BLOB_DIFF_PRINT=1` to print the real SDK transcript in the client suite. Extra arguments go to vitest.

## Run the Redis parity suite

The `parity:redis` task runs the real `@upstash/redis`, `@vercel/kv` and `@upstash/ratelimit` against a Redis container through an HTTP proxy, and the same scenarios against NATS. Set `NEXT_NATS_PARITY_RUNS` and `NEXT_NATS_PARITY_SEED` to change the number of generated cases and the fast-check seed. Stop the extra containers with `docker compose -p <project> -f devops/docker/compose/compose.yaml --profile redis down -v`.

## Run the end-to-end suite

`mise run e2e:run` builds the library, then builds `examples/demo` with Turbopack, with webpack (`next build --webpack`) and with `VERCEL=1`. Each build goes to its own directory under `examples/demo/.next-e2e`, so the demo's `.next` is never touched, and the suite removes the directory when it finishes. It then starts `next start` against NATS and checks:

- which implementation each build bundles for every mirrored package
- the demo pages and routes of each self-hosted build
- two replicas on one NATS sharing cache invalidation, rate limits, KV, blob signatures, queue delivery, realtime and cron
- recovery after `docker compose restart nats`, queue redelivery and KV transactions that stay all or nothing

The resilience tests restart the NATS container of the compose project, so run the suite in an isolated stack:

```sh
export NEXT_NATS_COMPOSE_PROJECT=nn-e2e
mise run compose:up
mise run e2e:run
```

The suite uses ports 3840 to 3859 and waits for one real cron tick, so a full run takes a few minutes. Extra arguments go to vitest, for example `mise run e2e:run replicas`.

| Variable | Effect |
| --- | --- |
| `E2E_SKIP_BUILD` | Reuse the builds already in `examples/demo/.next-e2e` |
| `E2E_KEEP_BUILDS` | Keep `examples/demo/.next-e2e` after the run |

Both are meant for iterating on one test file: keep the builds from a first run, then skip the build on the next.

## Run against a capped account

`devops/docker/compose/compose.yaml` has a `limits` profile with a second server, `nats-limited`, configured by `nats-limited.conf`. Its only account allows 5 streams, 50 consumers, no memory storage, 2.5 GiB of disk and requires `max_bytes`, the limits of a free Synadia Cloud account. It does not touch the default `nats` service. Connect with `NATS_USER=capped`, `NATS_PASSWORD=capped` and `NATS_STREAM_MAX_BYTES=128MiB` at `nats://nats-limited.<project>.orb.local:4222`.

`limits.test.ts` is part of `mise run e2e:run`. It starts the server, boots the demo once per capability, and checks that startup holds only the cron stream and that every capability provisions inside the cap. `mise run e2e:limits` runs it alone and reuses the builds when `E2E_SKIP_BUILD` is set.
