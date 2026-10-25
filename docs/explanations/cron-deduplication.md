# Cron deduplication

Every worker replica runs its own timer for each job, so without coordination a job would run once per replica. next-nats coordinates through JetStream instead of electing a leader.

## Mechanism

1. Each replica computes the next occurrence of the schedule and sleeps until then.
2. At the tick, each replica publishes a message to the `CRON` stream with the message id `<name>:<scheduledTime>`.
3. The stream rejects ids it has already seen inside its duplicate window, five minutes by default. Every replica computes the same scheduled time, so all publishes share one id and exactly one message is stored.
4. A single durable consumer per job, with explicit acknowledgement, delivers that message to one replica.

There is no leader to lose. If a replica dies, the others keep ticking and one of them still publishes the message the stream accepts.

## Failure handling

The handler runs under a deadline and the message is kept alive with progress signals while it runs. A failed attempt is redelivered after `retryDelayMs` until `maxDeliver` is reached, then the message is terminated and the run recorded as failed. A tick that reaches a worker later than `maxLatenessMs` is acknowledged without running and recorded as skipped.

## What the guarantee is

One tick is stored once, and it is delivered to one consumer at a time. Delivery is at least once: a replica that crashes mid-handler leaves the message unacknowledged and another replica runs it again. Handlers should be idempotent.

`triggerCron` publishes with the same id scheme, so triggering a tick that already exists reports `duplicate: true` and does nothing.

## Clock assumptions

Replicas must agree on the scheduled time, which derives from the schedule rather than from the moment of publishing. Clocks only need to be close enough that the publishes land inside the duplicate window.
