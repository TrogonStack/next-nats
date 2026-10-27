# Agents

Exports of `@trogonstack/next-nats/agents`, built on the Synadia Agent Protocol. Hosting uses `@synadia-ai/agent-service` and calling uses `@synadia-ai/agents`, both pinned at 0.6.0. Every option below maps onto an option of those packages: `AgentServiceOptions` in `@synadia-ai/agent-service/dist/index.d.ts` and `AgentsOptions` in `@synadia-ai/agents/dist/index.d.ts`.

## Hosting

`defineAgent(definition)` registers an agent on the shared connection, waits for the connection internally and returns an `ActiveAgent`. It only runs when workers are enabled. Otherwise it logs and returns a handle whose status is `stopped`. Defining the same prompt subject twice returns the first handle.

| Field | Meaning |
| --- | --- |
| `agent`, `owner`, `name` | Identity. `agent` and `owner` are advertised as metadata, `name` is the instance token of the subject |
| `subjectToken` | Wire token replacing `agent` in `agents.prompt.<token>.<owner>.<name>` |
| `session` | Conversation label advertised in metadata and on every heartbeat |
| `description`, `version` | Service description and version |
| `heartbeatIntervalS` | Heartbeat cadence in seconds, greater than zero |
| `keepaliveIntervalS` | Per-request keep-alive cadence in seconds, or `null` to disable |
| `attachmentsOk` | Whether the prompt endpoint advertises attachment support |
| `maxPayload` | Bytes or a size such as `"4MB"`. Defaults to the server maximum and is clamped to it |
| `extraMetadata` | Extra service metadata. The protocol identity keys always win |
| `extraEndpoints` | Custom endpoints on the same service. Names must not collide with `prompt` or `status` |
| `interceptors` | `RequestInterceptor` list run around the handler, first listed outermost |
| `heartbeatExtras` | Provider of extra fields for every heartbeat and status reply |
| `onPrompt(envelope, response)` | Handler. `response.send` streams chunks, `response.ask(prompt, { timeoutMs, signal })` asks the caller mid-stream and throws on timeout |
| `onError` | Receives a failure to start |

Sender identity options of the host package (`identity`, `minSenderTrust`, `acceptSender`, `operatorAttested`) are not exposed.

`ActiveAgent` has `identity`, `status()` and `stop()`. Status is `starting`, `running`, `stopped` or `error`. `stop()` is idempotent and removes the agent from the registry. A failed start stays registered with status `error` until it is stopped.

## Identity

`agentIdentity({ agent, owner, name, subjectToken? })` validates the tuple and derives `promptSubject`. The value objects `AgentName`, `AgentOwner`, `AgentInstanceName` and `AgentSubjectToken` come from `agentName`, `agentOwner`, `agentInstanceName` and `agentSubjectToken`. A token must be non-empty, must not start with `$` and must not contain whitespace, `.`, `*`, `>` or NUL, which is the rule of `AgentSubject.new` in `@synadia-ai/agents`.

## Calling

`getAgents()` resolves a process-cached `Agents` client built on the shared connection. It offers `discover({ timeoutMs, filter })`, `lookupInstance`, `ping`, `startTracking` and `liveness`. Each discovered `Agent` has `prompt(text, options)`, which resolves a stream of `response`, `status` and `query` messages, and `status()`. A `query` message has `reply(answer)`.

## Operations

`getAgentStatuses()` returns a snapshot of `{ agent, owner, name, subject, status, instanceId?, error? }` for every registered agent. `stopAllAgents()` stops every agent and closes the caller client.

On shutdown the `agents` stage runs first, ahead of consumers, the default stage and the drain. While at least one agent is registered, the diagnostics section `agents` reports the statuses.
