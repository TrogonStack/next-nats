import {
  AckPolicy,
  DeliverPolicy,
  JetStreamApiCodes,
  JetStreamApiError,
  type ConsumerConfig,
  type ConsumerMessages,
  type JsMsg,
} from "@nats-io/jetstream";
import { getNats } from "../connection.js";
import { untilStreamExists } from "../streams.js";
import { getLogger } from "../logger.js";
import { ackLease } from "./delivery.js";
import { durableFor, filterSubject, matchesTopic, provision, readStored, replyOf, type QueueStore, type StoredMessage } from "./store.js";
import type { CursorFallback } from "./types.js";

const NANOS_PER_SECOND = 1_000_000_000;

export async function ensureConsumer(store: QueueStore, pattern: string, group: string, ackWaitSeconds: number, cursor: CursorFallback = "earliest"): Promise<string> {
  await provision(store);
  const { jsm } = await getNats();
  const durable = durableFor(pattern, group);
  const ackWait = ackWaitSeconds * NANOS_PER_SECOND;
  try {
    const info = await jsm.consumers.info(store.stream, durable);
    if (info.config.ack_wait !== ackWait) await jsm.consumers.update(store.stream, durable, { ack_wait: ackWait });
  } catch (error) {
    if (!(error instanceof JetStreamApiError) || error.code !== JetStreamApiCodes.ConsumerNotFound) throw error;
    const config: Partial<ConsumerConfig> = {
      durable_name: durable,
      ack_policy: AckPolicy.Explicit,
      ack_wait: ackWait,
      max_deliver: -1,
      filter_subject: filterSubject(store, pattern),
      deliver_policy: cursor === "latest" ? DeliverPolicy.New : DeliverPolicy.All,
    };
    await jsm.consumers.add(store.stream, config);
  }
  return durable;
}

export async function discard(msg: JsMsg): Promise<void> {
  const { nc } = await getNats();
  await ackLease(nc, replyOf(msg)).ack();
}

export function isLive(stored: StoredMessage, now = Date.now()): boolean {
  return stored.expiresAt.getTime() > now;
}

export interface ConsumerLoop {
  stop(): Promise<void>;
}

export interface ConsumerLoopOptions {
  store: QueueStore;
  pattern: string;
  group: string;
  ackWaitSeconds: number;
  concurrency: number;
  cursor?: CursorFallback;
  onMessage(stored: StoredMessage): Promise<void>;
}

export function runConsumerLoop(options: ConsumerLoopOptions): ConsumerLoop {
  const { store, pattern, group, ackWaitSeconds, concurrency } = options;
  let stopped = false;
  const abort = new AbortController();
  let iterator: ConsumerMessages | undefined;
  const inflight = new Set<Promise<void>>();

  const handle = async (msg: JsMsg) => {
    try {
      let stored: StoredMessage;
      try {
        stored = readStored(msg, store);
      } catch {
        msg.term("corrupt queue message");
        return;
      }
      if (!matchesTopic(pattern, stored.topic) || !isLive(stored)) {
        await discard(msg);
        return;
      }
      await options.onMessage(stored);
    } catch (error) {
      getLogger().error("queue delivery failed", { error, pattern, group });
      try {
        msg.nak(5_000);
      } catch {
        return;
      }
    }
  };

  const run = async () => {
    let backoff = 1_000;
    while (!stopped) {
      try {
        await untilStreamExists(store.stream, { subjects: [filterSubject(store, pattern)], signal: abort.signal });
        if (stopped) break;
        const durable = await ensureConsumer(store, pattern, group, ackWaitSeconds, options.cursor);
        const { js } = await getNats();
        const consumer = await js.consumers.get(store.stream, durable);
        iterator = await consumer.consume({ max_messages: concurrency, idle_heartbeat: 5_000 });
        backoff = 1_000;
        for await (const msg of iterator) {
          if (stopped) {
            msg.nak();
            break;
          }
          const task: Promise<void> = handle(msg).finally(() => inflight.delete(task));
          inflight.add(task);
          if (inflight.size >= concurrency) await Promise.race(inflight);
        }
      } catch (error) {
        if (stopped) break;
        getLogger().warning("queue consumer restarting", { error, pattern, group });
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
    await Promise.allSettled(inflight);
  };

  const done = run();
  return {
    async stop() {
      stopped = true;
      abort.abort();
      await iterator?.close().catch(() => undefined);
      await done.catch(() => undefined);
    },
  };
}
