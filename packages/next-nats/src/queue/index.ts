import "server-only";
import { createQueueClient, type QueueClient } from "./client.js";
import type {
  BatchSendMessage,
  BatchSendResult,
  ConsumeOptions,
  MessageHandler,
  QueueClientOptions,
  QueueSubscription,
  ReceiveOptions,
  ReceiveResult,
  SendOptions,
  SendResult,
} from "./types.js";

export { createQueueClient, defaultRetryDelaySeconds, type QueueClient } from "./client.js";
export * from "./types.js";

const KEY = Symbol.for("next-nats.queue.default");

type Holder = { [KEY]?: QueueClient };

export function configureQueue(options: QueueClientOptions): QueueClient {
  const g = globalThis as Holder;
  g[KEY] = createQueueClient(options);
  return g[KEY];
}

export function defaultQueue(): QueueClient {
  const g = globalThis as Holder;
  return (g[KEY] ??= createQueueClient());
}

export const send = <T = unknown>(topic: string, payload: T, options?: SendOptions): Promise<SendResult> =>
  defaultQueue().send(topic, payload, options);

export const sendBatch = <T = unknown>(topic: string, messages: readonly BatchSendMessage<T>[]): Promise<BatchSendResult[]> =>
  defaultQueue().sendBatch(topic, messages);

export const subscribe = <T = unknown>(
  topic: string,
  consumerGroup: string,
  handler: MessageHandler<T>,
  options?: ConsumeOptions,
): QueueSubscription => defaultQueue().subscribe(topic, consumerGroup, handler, options);

export const receive = <T = unknown>(
  topic: string,
  consumerGroup: string,
  handler: MessageHandler<T>,
  options?: ReceiveOptions,
): Promise<ReceiveResult> => defaultQueue().receive(topic, consumerGroup, handler, options);

export const handleCallback = <T = unknown>(handler: MessageHandler<T>, options?: ReceiveOptions & { consumerGroup?: string }) =>
  defaultQueue().handleCallback(handler, options);
