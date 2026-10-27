import "server-only";
import { AckPolicy, JetStreamApiCodes, JetStreamApiError, type ConsumerConfig, type ConsumerMessages, type JsMsg } from "@nats-io/jetstream";
import { headers as natsHeaders } from "@nats-io/nats-core";
import { codec } from "./codec.js";
import { getNatsConfig, getNats, onNatsShutdown } from "./connection.js";
import { untilStreamExists } from "./streams.js";
import { durableName, streamName, subject, type DurableName, type StreamName, type Subject } from "./values.js";

const NANOS_PER_MS = 1_000_000;

export interface DeadLetterOptions {
  subject: Subject | string;
}

export interface ConsumerDefinition<T = unknown> {
  stream: StreamName | string;
  durable: DurableName | string;
  filterSubjects?: Array<Subject | string>;
  ackWait?: number;
  maxDeliver?: number;
  backoff?: number[];
  maxAckPending?: number;
  deadLetter?: DeadLetterOptions;
  provision?: boolean;
  handler: (payload: T, msg: JsMsg) => void | Promise<void>;
  onError?: (error: unknown, msg?: JsMsg) => void;
}

export interface ActiveConsumer {
  readonly durable: DurableName;
  stop(): Promise<void>;
}

const REGISTRY_KEY = Symbol.for("next-nats.consumers");

function registry(): Map<string, ActiveConsumer> {
  const g = globalThis as unknown as Record<symbol, Map<string, ActiveConsumer> | undefined>;
  return (g[REGISTRY_KEY] ??= new Map());
}

export function defineConsumer<T = unknown>(def: ConsumerDefinition<T>): ActiveConsumer {
  const stream = streamName(def.stream);
  const durable = durableName(def.durable);
  const key = `${stream}/${durable}`;

  const existing = registry().get(key);
  if (existing) return existing;

  if (!getNatsConfig().workers) {
    return { durable, stop: async () => {} };
  }

  const ackWait = def.ackWait ?? 30_000;
  const maxDeliver = def.maxDeliver ?? 5;
  const deadLetterSubject = def.deadLetter ? subject(def.deadLetter.subject) : undefined;
  const filters = def.filterSubjects?.map(subject);

  let stopped = false;
  const abort = new AbortController();
  let iterator: ConsumerMessages | undefined;
  let done: Promise<void> = Promise.resolve();

  const provision = async () => {
    const { jsm } = await getNats();
    const config: Partial<ConsumerConfig> = {
      durable_name: durable,
      ack_policy: AckPolicy.Explicit,
      ack_wait: ackWait * NANOS_PER_MS,
      max_deliver: maxDeliver,
      ...(def.maxAckPending && { max_ack_pending: def.maxAckPending }),
      ...(def.backoff?.length && { backoff: def.backoff.map((ms) => ms * NANOS_PER_MS) }),
      ...(filters?.length === 1 && { filter_subject: filters[0] }),
      ...((filters?.length ?? 0) > 1 && { filter_subjects: filters }),
    };
    try {
      await jsm.consumers.info(stream, durable);
    } catch (err) {
      if (!(err instanceof JetStreamApiError) || err.code !== JetStreamApiCodes.ConsumerNotFound) throw err;
      await jsm.consumers.add(stream, config);
    }
  };

  const deadLetter = async (msg: JsMsg, error: unknown) => {
    const { js } = await getNats();
    const h = natsHeaders();
    h.set("x-dead-letter-subject", msg.subject);
    h.set("x-dead-letter-stream", msg.info.stream);
    h.set("x-dead-letter-durable", durable);
    h.set("x-dead-letter-deliveries", String(msg.info.deliveryCount));
    h.set("x-dead-letter-error", error instanceof Error ? error.message : String(error));
    await js.publish(deadLetterSubject!, msg.data, { headers: h });
  };

  const handle = async (msg: JsMsg) => {
    const heartbeat = setInterval(() => {
      try {
        msg.working();
      } catch {
        return;
      }
    }, Math.max(1_000, Math.floor(ackWait / 2)));
    try {
      await def.handler(codec.tryDecodeJson<T>(msg.data) as T, msg);
      msg.ack();
    } catch (error) {
      def.onError?.(error, msg);
      const exhausted = msg.info.deliveryCount >= maxDeliver;
      if (exhausted && deadLetterSubject) {
        try {
          await deadLetter(msg, error);
          msg.term(`dead-lettered to ${deadLetterSubject} after ${msg.info.deliveryCount} deliveries`);
        } catch {
          msg.nak(ackWait);
        }
      } else if (exhausted) {
        msg.term(`maxDeliver ${maxDeliver} exhausted`);
      } else {
        const delay = def.backoff?.[Math.min(msg.info.deliveryCount - 1, def.backoff.length - 1)];
        msg.nak(delay);
      }
    } finally {
      clearInterval(heartbeat);
    }
  };

  const run = async () => {
    let retry = 1_000;
    while (!stopped) {
      try {
        await untilStreamExists(stream, { subjects: filters, signal: abort.signal });
        if (stopped) break;
        const { js } = await getNats();
        if (def.provision ?? true) await provision();
        const consumer = await js.consumers.get(stream, durable);
        iterator = await consumer.consume({ max_messages: 1, idle_heartbeat: 5_000 });
        retry = 1_000;
        for await (const msg of iterator) {
          if (stopped) {
            msg.nak();
            break;
          }
          await handle(msg);
        }
      } catch (error) {
        if (stopped) break;
        def.onError?.(error);
        await new Promise((resolve) => setTimeout(resolve, retry));
        retry = Math.min(retry * 2, 30_000);
      }
    }
  };

  done = run();

  const active: ActiveConsumer = {
    durable,
    async stop() {
      stopped = true;
      abort.abort();
      registry().delete(key);
      await iterator?.close().catch(() => undefined);
      await done.catch(() => undefined);
    },
  };
  registry().set(key, active);
  onNatsShutdown(() => active.stop(), { stage: "consumers" });
  return active;
}

export async function stopAllConsumers(): Promise<void> {
  await Promise.all([...registry().values()].map((c) => c.stop()));
}
