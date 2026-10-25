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
| `mise run redis:parity` | Start Redis and its HTTP proxy, then run the Redis, KV and ratelimit differential suites |
| `mise run demo:dev` | Run the demo in development mode |
| `mise run demo:start` | Run the built demo |
| `mise run demo:verify-cache` | Check cache coherency across two replicas |
| `mise run ci` | Install, build, typecheck and test |

`NATS_SERVERS` defaults to `nats://nats.next-nats.orb.local:4222` in these tasks. Export it to point somewhere else, or set `NEXT_NATS_COMPOSE_PROJECT` to run an isolated stack whose server is `nats://nats.<project>.orb.local:4222`.

The compose file lives at `devops/docker/compose/compose.yaml` and keeps the project name `next-nats`.

The `redis:parity` task runs the real `@upstash/redis`, `@vercel/kv` and `@upstash/ratelimit` against a Redis container through an HTTP proxy, and the same scenarios against NATS. Set `NEXT_NATS_PARITY_RUNS` and `NEXT_NATS_PARITY_SEED` to change the number of generated cases and the fast-check seed. Stop the extra containers with `docker compose -p <project> -f devops/docker/compose/compose.yaml --profile redis down -v`.
