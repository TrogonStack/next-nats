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
| `mise run demo:dev` | Run the demo in development mode |
| `mise run demo:start` | Run the built demo |
| `mise run demo:verify-cache` | Check cache coherency across two replicas |
| `mise run blob-parity` | Compare `@trogonstack/next-nats/blob` with `@vercel/blob` |
| `mise run parity:edge-queue` | Run the Edge Config, queue and cron differential suites |
| `mise run ci` | Install, build, typecheck and test |

`NATS_SERVERS` defaults to `nats://nats.next-nats.orb.local:4222` in these tasks. Export it to point somewhere else, or set `NEXT_NATS_COMPOSE_PROJECT` to run an isolated stack whose server is `nats://nats.<project>.orb.local:4222`.

The compose file lives at `devops/docker/compose/compose.yaml` and keeps the project name `next-nats`.

## Run the blob parity suite

`mise run blob-parity` runs the same scenarios through the real `@vercel/blob` against a local fake of the Vercel Blob service and through `@trogonstack/next-nats/blob` against NATS, then compares the results. The model test logs its seed. Set `BLOB_MODEL_SEED` to replay a run and `BLOB_MODEL_RUNS` to change its length. Set `BLOB_DIFF_PRINT=1` to print the real SDK transcript in the client suite. Extra arguments go to vitest.
