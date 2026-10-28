# Contributing

## Prerequisites

- [mise](https://mise.jdx.dev), which installs the pinned Node.js from `mise.toml`
- Docker, for the local NATS server

## Setup

```sh
mise install
mise run install
mise run compose:up
```

The tasks connect to `nats://nats.next-nats.orb.local:4222`, the OrbStack hostname of the compose service. Set `NATS_URL=nats://localhost:4222` when running Docker without OrbStack.

## Checks

Run these before opening a pull request:

```sh
mise run build
mise run typecheck
mise run test
```

`mise run ci` runs install, build, typecheck and test in one go.

## End-to-end tests

```sh
mise run e2e:run     # build the demo and run it against NATS
mise run e2e:limits  # run against an account capped like Synadia Cloud
```

## Parity suites

The differential suites run the real Vercel and Upstash clients side by side with these implementations:

```sh
mise run parity:redis
mise run parity:blob
mise run parity:edge-queue
```

## Demo

```sh
mise run demo:dev    # development mode
mise run demo:start  # production build with the NATS workers enabled
```

## Commits and pull requests

- Commit messages and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org).
- All commits require a DCO sign-off (`git commit -s`).
