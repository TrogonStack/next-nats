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
| `mise run ci` | Install, build, typecheck and test |

`NATS_SERVERS` defaults to `nats://nats.next-nats.orb.local:4222` in these tasks. Export it to point somewhere else.

The compose file lives at `devops/docker/compose/compose.yaml` and keeps the project name `next-nats`.
