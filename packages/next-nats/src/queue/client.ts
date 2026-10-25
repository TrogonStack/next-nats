import "server-only";
import { randomUUID } from "node:crypto";
import {
  AckPolicy,
  DeliverPolicy,
  JetStreamApiCodes,
  JetStreamApiError,
  type ConsumerConfig,
  type ConsumerMessages,
  type JsMsg,
} from "@nats-io/jetstream";
import { headers as natsHeaders } from "@nats-io/nats-core";
import { getNats, getNatsConfig, onNatsShutdown } from "../connection.js";
import { ensureStream } from "../streams.js";
import { decodeEnvelope, encodeEnvelope } from "./envelope.js";
import { assertGroup, assertTopic, durableFor, subjects } from "./topic.js";
import type {
  BatchSendMessage,
  BatchSendResult,
  ConsumeOptions,
  MessageHandler,
  MessageMetadata,
  QueueClientOptions,
  QueueSubscription,
  ReceiveOptions,
  ReceiveResult,
  RetryDirective,
  SendOptions,
  SendResult,
} from "./types.js";

const NANOS_PER_SECOND = 1_000_000_000;
const DAY = 86_400;

export interface QueueClient {
  readonly stream: string;
  send<T = unknown>(topic: string, payload: T, options?: SendOptions): Promise<SendResult>;
  sendBatch<T = unknown>(topic: string, messages: readonly BatchSendMessage<T>[]): Promise<BatchSendResult[]>;
  subscribe<T = unknown>(topic: string, consumerGroup: string, handler: MessageHandler<T>, options?: ConsumeOptions): QueueSubscription;
  receive<T = unknown>(topic: string, consumerGroup: string, handler: MessageHandler<T>, options?: ReceiveOptions): Promise<ReceiveResult>;
  handleCallback<T = unknown>(handler: MessageHandler<T>, options?: ReceiveOptions & { consumerGroup?: string }): (request: Request) => Promise<Response>;
  stop(): Promise<void>;
}

export function defaultRetryDelaySeconds(deliveryCount: number): number {
  return Math.min(2 ** Math.max(0, deliveryCount - 1), 300);
}

export function createQueueClient(options: QueueClientOptions = {}): QueueClient {
  const stream = options.stream ?? "QUEUE";
  const prefix = options.prefix ?? "queue";
  const maxRetention = options.maxRetentionSeconds ?? 7 * DAY;
  const defaultRetention = Math.min(options.retentionSeconds ?? DAY, maxRetention);
  const region = options.region ?? "nats";
  const duplicateWindow = Math.min(options.duplicateWindowSeconds ?? 3_600, maxRetention);
  const owned = new Set<QueueSubscription>();
  const active = new Map<string, QueueSubscription>();
  let ready: Promise<unknown> | undefined;

  const provision = () =>
    (ready ??= ensureStream({
      name: stream,
      subjects: [`${prefix}.t.>`, `${prefix}.s.>`, `${prefix}.d.>`],
      max_age: maxRetention * NANOS_PER_SECOND,
      duplicate_window: duplicateWindow * NANOS_PER_SECOND,
      allow_msg_schedules: true,
      allow_msg_ttl: true,
    } as Parameters<typeof ensureStream>[0]).catch((error) => {
      ready = undefined;
      throw error;
    }));

  const send = async <T>(topic: string, payload: T, opts: SendOptions = {}): Promise<SendResult> => {
    assertTopic(topic);
    await provision();
    const { js } = await getNats();
    const id = opts.idempotencyKey ?? randomUUID();
    const now = Date.now();
    const retention = Math.min(opts.retentionSeconds ?? defaultRetention, maxRetention);
    const delayMs = Math.max(0, (opts.delaySeconds ?? 0) * 1000);
    const body = encodeEnvelope(id, payload, now, now + delayMs + retention * 1000, opts.headers);
    const names = subjects(prefix, topic);
    if (delayMs > 0) {
      await js.publish(names.schedule(randomUUID()), body, {
        msgID: id,
        schedule: { specification: new Date(now + delayMs), target: names.message },
      });
    } else {
      await js.publish(names.message, body, { msgID: id });
    }
    return { messageId: id };
  };

  const sendBatch = async <T>(topic: string, messages: readonly BatchSendMessage<T>[]): Promise<BatchSendResult[]> =>
    Promise.all(
      messages.map(async ({ payload, ...opts }): Promise<BatchSendResult> => {
        try {
          const { messageId } = await send(topic, payload, opts);
          return { status: "sent", messageId: messageId! };
        } catch (error) {
          return { status: "failed", statusCode: 500, error: error instanceof Error ? error.message : String(error), retryable: true };
        }
      }),
    );

  const provisionConsumer = async (topic: string, group: string, visibility: number, maxDeliver: number, fallback: "earliest" | "latest") => {
    await provision();
    const { jsm } = await getNats();
    const durable = durableFor(topic, group);
    try {
      await jsm.consumers.info(stream, durable);
    } catch (err) {
      if (!(err instanceof JetStreamApiError) || err.code !== JetStreamApiCodes.ConsumerNotFound) throw err;
      const config: Partial<ConsumerConfig> = {
        durable_name: durable,
        ack_policy: AckPolicy.Explicit,
        ack_wait: visibility * NANOS_PER_SECOND,
        max_deliver: maxDeliver,
        filter_subject: subjects(prefix, topic).message,
        deliver_policy: fallback === "latest" ? DeliverPolicy.New : DeliverPolicy.All,
      };
      await jsm.consumers.add(stream, config);
    }
    return durable;
  };

  const deadLetter = async (topic: string, msg: JsMsg, group: string, error: unknown) => {
    const { js } = await getNats();
    const h = natsHeaders();
    h.set("x-dead-letter-group", group);
    h.set("x-dead-letter-deliveries", String(msg.info.deliveryCount));
    h.set("x-dead-letter-error", error instanceof Error ? error.message : String(error));
    await js.publish(subjects(prefix, topic).deadLetter, msg.data, { headers: h });
  };

  const metadataFor = (topic: string, group: string, msg: JsMsg, envelope: ReturnType<typeof decodeEnvelope>["envelope"]): MessageMetadata => ({
    messageId: envelope.id,
    deliveryCount: msg.info.deliveryCount,
    createdAt: new Date(envelope.createdAt),
    expiresAt: new Date(envelope.expiresAt),
    topicName: topic,
    consumerGroup: group,
    region,
    headers: envelope.headers ?? {},
  });

  const handleMessage = async <T>(topic: string, group: string, msg: JsMsg, handler: MessageHandler<T>, opts: ConsumeOptions, visibility: number, maxDeliver: number) => {
    let decoded: ReturnType<typeof decodeEnvelope<T>>;
    try {
      decoded = decodeEnvelope<T>(msg.data);
    } catch (error) {
      opts.onError?.(error);
      msg.term("corrupt envelope");
      return;
    }
    const metadata = metadataFor(topic, group, msg, decoded.envelope);
    if (metadata.expiresAt.getTime() < Date.now()) {
      msg.ack();
      return;
    }
    const heartbeat = setInterval(() => {
      try {
        msg.working();
      } catch {
        return;
      }
    }, Math.max(1_000, Math.floor((visibility * 1000) / 2)));
    try {
      await handler(decoded.payload, metadata);
      msg.ack();
    } catch (error) {
      opts.onError?.(error, metadata);
      let directive: RetryDirective | void | undefined;
      try {
        directive = opts.retry?.(error, metadata);
      } catch (retryError) {
        opts.onError?.(retryError, metadata);
      }
      if (directive && "acknowledge" in directive) {
        msg.ack();
      } else if (msg.info.deliveryCount >= maxDeliver) {
        try {
          await deadLetter(topic, msg, group, error);
          msg.term("dead-lettered");
        } catch {
          msg.nak(visibility * 1000);
        }
      } else {
        const seconds = directive ? directive.afterSeconds : defaultRetryDelaySeconds(msg.info.deliveryCount);
        msg.nak(seconds * 1000);
      }
    } finally {
      clearInterval(heartbeat);
    }
  };

  const subscribe = <T>(topic: string, consumerGroup: string, handler: MessageHandler<T>, opts: ConsumeOptions = {}): QueueSubscription => {
    assertTopic(topic);
    assertGroup(consumerGroup);
    const key = `${stream}/${topic}/${consumerGroup}`;
    const existing = active.get(key);
    if (existing) return existing;
    if (!getNatsConfig().workers) return { topic, consumerGroup, stop: async () => {} };

    const visibility = opts.visibilityTimeoutSeconds ?? 30;
    const maxDeliver = opts.maxDeliveries ?? 10;
    const concurrency = Math.max(1, opts.concurrency ?? 1);
    let stopped = false;
    let iterator: ConsumerMessages | undefined;
    const inflight = new Set<Promise<void>>();

    const run = async () => {
      let retry = 1_000;
      while (!stopped) {
        try {
          const durable = await provisionConsumer(topic, consumerGroup, visibility, maxDeliver, opts.cursorFallback ?? "earliest");
          const { js } = await getNats();
          const consumer = await js.consumers.get(stream, durable);
          iterator = await consumer.consume({ max_messages: concurrency, idle_heartbeat: 5_000 });
          retry = 1_000;
          for await (const msg of iterator) {
            if (stopped) {
              msg.nak();
              break;
            }
            const task = handleMessage(topic, consumerGroup, msg, handler, opts, visibility, maxDeliver).finally(() => inflight.delete(task));
            inflight.add(task);
            if (inflight.size >= concurrency) await Promise.race(inflight);
          }
        } catch (error) {
          if (stopped) break;
          opts.onError?.(error);
          await new Promise((resolve) => setTimeout(resolve, retry));
          retry = Math.min(retry * 2, 30_000);
        }
      }
      await Promise.allSettled(inflight);
    };

    const done = run();
    const subscription: QueueSubscription = {
      topic,
      consumerGroup,
      async stop() {
        stopped = true;
        active.delete(key);
        owned.delete(subscription);
        await iterator?.close().catch(() => undefined);
        await done.catch(() => undefined);
      },
    };
    active.set(key, subscription);
    owned.add(subscription);
    onNatsShutdown(() => subscription.stop());
    return subscription;
  };

  const receive = async <T>(topic: string, consumerGroup: string, handler: MessageHandler<T>, opts: ReceiveOptions = {}): Promise<ReceiveResult> => {
    assertTopic(topic);
    assertGroup(consumerGroup);
    const visibility = opts.visibilityTimeoutSeconds ?? 30;
    const maxDeliver = opts.maxDeliveries ?? 10;
    const durable = await provisionConsumer(topic, consumerGroup, visibility, maxDeliver, opts.cursorFallback ?? "earliest");
    const { js } = await getNats();
    const consumer = await js.consumers.get(stream, durable);
    const batch = await consumer.fetch({ max_messages: opts.limit ?? 1, expires: Math.max(1_000, (opts.waitSeconds ?? 1) * 1000) });
    const tasks: Promise<void>[] = [];
    for await (const msg of batch) tasks.push(handleMessage(topic, consumerGroup, msg, handler, opts, visibility, maxDeliver));
    await Promise.all(tasks);
    return tasks.length === 0 ? { ok: false, reason: "empty" } : { ok: true, processed: tasks.length };
  };

  const handleCallback = <T>(handler: MessageHandler<T>, opts: ReceiveOptions & { consumerGroup?: string } = {}) =>
    async (request: Request): Promise<Response> => {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = (await request.json().catch(() => null)) as { queueName?: string; consumerGroup?: string } | null;
      if (!body?.queueName) return Response.json({ error: "queueName is required" }, { status: 400 });
      try {
        const result = await receive<T>(body.queueName, body.consumerGroup ?? opts.consumerGroup ?? "default", handler, opts);
        return Response.json(result);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    };

  return {
    stream,
    send,
    sendBatch,
    subscribe,
    receive,
    handleCallback,
    async stop() {
      await Promise.all([...owned].map((s) => s.stop()));
    },
  };
}

