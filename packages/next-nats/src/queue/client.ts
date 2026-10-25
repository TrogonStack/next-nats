import "server-only";
import { getNats } from "../connection.js";
import { PayloadTooLargeError, BadRequestError, InvalidLimitError } from "./errors.js";
import { nodeCallback, webCallback, type CallbackContext } from "./callback.js";
import { ensureConsumer } from "./consumer.js";
import { ackLease, clampVisibility, encodeReceipt, processDelivery } from "./delivery.js";
import {
  assertName,
  publishMessage,
  readStored,
  resolveRegion,
  resolveStore,
  type QueueStore,
  type QueueStoreOptions,
} from "./store.js";
import { bufferToStream, JsonTransport, streamToBuffer, type Transport } from "./transport.js";
import type {
  BatchSendMessage,
  BatchSendOptions,
  BatchSendResult,
  HandleCallbackOptions,
  Message,
  MessageHandler,
  PollingQueueClientOptions,
  QueueClientOptions,
  ReceiveOptions,
  ReceiveResult,
  SendOptions,
  SendResult,
  VercelRegion,
  CallbackRequestInput,
  NodeCallbackRequest,
  NodeCallbackResponse,
} from "./types.js";

export type QueueClientInit = QueueClientOptions & { nats?: QueueStoreOptions };
export type PollingQueueClientInit = PollingQueueClientOptions & { nats?: QueueStoreOptions };

export interface ClientInternals {
  store: () => QueueStore;
  transport: Transport;
  region: string;
}

const internals = new WeakMap<object, ClientInternals>();

export function internalsOf(client: object): ClientInternals {
  const found = internals.get(client);
  if (!found) throw new Error("QueueClient not initialized");
  return found;
}

function register(client: object, options: QueueClientInit): ClientInternals {
  const value: ClientInternals = {
    store: () => resolveStore(options.nats),
    transport: options.transport ?? new JsonTransport(),
    region: resolveRegion(options.region),
  };
  internals.set(client, value);
  return value;
}

async function toBytes(transport: Transport, payload: unknown): Promise<Uint8Array> {
  const serialized = transport.serialize(payload);
  return serialized instanceof ReadableStream ? streamToBuffer(serialized) : serialized;
}

async function sendOne<T>(self: ClientInternals, topic: string, payload: T, options?: SendOptions): Promise<SendResult> {
  assertName("topic", topic);
  const body = await toBytes(self.transport, payload);
  return publishMessage(self.store(), self.region, topic, body, self.transport.contentType, options);
}

function failureOf(error: unknown): BatchSendResult {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof BadRequestError) return { status: "failed", statusCode: 400, error: message, retryable: false };
  if (error instanceof PayloadTooLargeError) return { status: "failed", statusCode: 413, error: message, retryable: false };
  return { status: "failed", statusCode: 500, error: message, retryable: true };
}

async function sendMany<T>(self: ClientInternals, topic: string, messages: readonly BatchSendMessage<T>[], _options?: BatchSendOptions): Promise<BatchSendResult[]> {
  if (messages.length < 1 || messages.length > 100) throw new RangeError("Batch size must be between 1 and 100 messages");
  assertName("topic", topic);
  return Promise.all(
    messages.map(async ({ payload, ...options }): Promise<BatchSendResult> => {
      try {
        const { messageId } = await sendOne(self, topic, payload, options);
        return { status: "sent", messageId: messageId! };
      } catch (error) {
        return failureOf(error);
      }
    }),
  );
}

export class QueueClient {
  constructor(options: QueueClientInit = {}) {
    const self = register(this, options);
    this.send = (topicName, payload, sendOptions) => sendOne(self, topicName, payload, sendOptions);
    this.sendBatch = (topicName, messages, batchOptions) => sendMany(self, topicName, messages, batchOptions);
    this.experimental_sendBatch = this.sendBatch;
    const ctx = (): CallbackContext => ({ store: self.store(), transport: self.transport, region: self.region });
    this.handleCallback = (handler, callbackOptions) => webCallback(handler, callbackOptions, ctx);
    this.handleNodeCallback = (handler, callbackOptions) => nodeCallback(handler, callbackOptions, ctx);
  }

  send: <T = unknown>(topicName: string, payload: T, options?: SendOptions) => Promise<SendResult>;
  sendBatch: <T = unknown>(topicName: string, messages: readonly BatchSendMessage<T>[], options?: BatchSendOptions) => Promise<BatchSendResult[]>;
  experimental_sendBatch: <T = unknown>(topicName: string, messages: readonly BatchSendMessage<T>[], options?: BatchSendOptions) => Promise<BatchSendResult[]>;
  handleCallback: <T = unknown>(handler: MessageHandler<T>, options?: HandleCallbackOptions) => (requestOrEvent: CallbackRequestInput) => Promise<Response>;
  handleNodeCallback: <T = unknown>(
    handler: MessageHandler<T>,
    options?: HandleCallbackOptions,
  ) => (req: NodeCallbackRequest, res: NodeCallbackResponse) => Promise<void>;
}

const FETCH_WAIT_MS = 1_000;

async function receiveBatch<T>(self: ClientInternals, topic: string, group: string, handler: MessageHandler<T>, options: ReceiveOptions | undefined): Promise<ReceiveResult> {
  assertName("topic", topic);
  assertName("consumer group", group);
  if (options && "messageId" in options) {
    throw new BadRequestError("Receiving a message by messageId is not supported by the NATS queue");
  }
  const batch = options && "limit" in options ? options.limit : undefined;
  if (batch !== undefined && (batch < 1 || batch > 10)) throw new InvalidLimitError(batch);
  const store = self.store();
  const visibility = clampVisibility(options?.visibilityTimeoutSeconds);
  const cursor = options && "cursorFallback" in options ? options.cursorFallback : undefined;
  const durable = await ensureConsumer(store, topic, group, visibility, cursor);
  const { nc, js } = await getNats();
  const consumer = await js.consumers.get(store.stream, durable);
  const messages = await consumer.fetch({ max_messages: batch ?? 1, expires: FETCH_WAIT_MS });
  let processed = 0;
  let failure: { error: unknown } | undefined;
  for await (const msg of messages) {
    if (failure) {
      msg.nak();
      continue;
    }
    let stored;
    try {
      stored = readStored(msg, store);
    } catch {
      msg.term("corrupt queue message");
      continue;
    }
    if (stored.expiresAt.getTime() <= Date.now()) {
      msg.ack();
      continue;
    }
    processed++;
    const message: Message<T> = {
      messageId: stored.messageId,
      payload: (await self.transport.deserialize(bufferToStream(stored.body))) as T,
      deliveryCount: stored.deliveryCount,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
      contentType: stored.contentType,
      receiptHandle: encodeReceipt(stored.reply),
    };
    try {
      await processDelivery(handler, {
        topicName: topic,
        consumerGroup: group,
        region: stored.region,
        message,
        lease: ackLease(nc, stored.reply),
        visibilityTimeoutSeconds: visibility,
        retry: options?.retry,
        transport: self.transport,
      });
    } catch (error) {
      failure = { error };
    }
  }
  if (failure) throw failure.error;
  return processed === 0 ? { ok: false, reason: "empty" } : { ok: true };
}

export class PollingQueueClient {
  constructor(options: PollingQueueClientInit) {
    const self = register(this, options);
    this.send = (topicName, payload, sendOptions) => sendOne(self, topicName, payload, sendOptions);
    this.sendBatch = (topicName, messages, batchOptions) => sendMany(self, topicName, messages, batchOptions);
    this.experimental_sendBatch = this.sendBatch;
    this.receive = (topicName, consumerGroup, handler, receiveOptions) => receiveBatch(self, topicName, consumerGroup, handler, receiveOptions);
  }

  send: <T = unknown>(topicName: string, payload: T, options?: SendOptions) => Promise<SendResult>;
  sendBatch: <T = unknown>(topicName: string, messages: readonly BatchSendMessage<T>[], options?: BatchSendOptions) => Promise<BatchSendResult[]>;
  experimental_sendBatch: <T = unknown>(topicName: string, messages: readonly BatchSendMessage<T>[], options?: BatchSendOptions) => Promise<BatchSendResult[]>;
  receive: <T = unknown>(topicName: string, consumerGroup: string, handler: MessageHandler<T>, options?: ReceiveOptions) => Promise<ReceiveResult>;
}

const DEFAULT_CLIENT = Symbol.for("next-nats.queue.defaultClient");

function defaultClient(): QueueClient {
  const holder = globalThis as Record<symbol, QueueClient | undefined>;
  return (holder[DEFAULT_CLIENT] ??= new QueueClient());
}

function clientFor(region: VercelRegion | undefined): QueueClient {
  return region ? new QueueClient({ region }) : defaultClient();
}

export function send<T = unknown>(topicName: string, payload: T, options?: SendOptions & { region?: VercelRegion }): Promise<SendResult> {
  return clientFor(options?.region).send(topicName, payload, options);
}

export function sendBatch<T = unknown>(topicName: string, messages: readonly BatchSendMessage<T>[], options?: BatchSendOptions & { region?: VercelRegion }): Promise<BatchSendResult[]> {
  return clientFor(options?.region).sendBatch(topicName, messages, options);
}

export const experimental_sendBatch: typeof sendBatch = sendBatch;

export function handleCallback<T = unknown>(handler: MessageHandler<T>, options?: HandleCallbackOptions): (requestOrEvent: CallbackRequestInput) => Promise<Response> {
  return defaultClient().handleCallback(handler, options);
}
