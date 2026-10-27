import "server-only";
import type { PubAck } from "@nats-io/jetstream";
import { codec } from "./codec.js";
import { getNats } from "./connection.js";
import {
  buildHeaders,
  isRetriablePublishError,
  retryDelay,
  validateRetry,
  type PayloadOf,
  type PublishOptions,
  type SubjectName,
  type TraceOptions,
} from "./publish-core.js";

export {
  isRetriablePublishError,
  resolveTrace,
  retryDelay,
  type BackoffOptions,
  type NatsEvents,
  type PayloadOf,
  type PublishOptions,
  type RetryOptions,
  type SubjectName,
  type TraceOptions,
} from "./publish-core.js";

export async function jsPublish<S extends SubjectName>(
  subject: S,
  payload: PayloadOf<S>,
  opts: PublishOptions = {},
): Promise<PubAck> {
  const { js } = await getNats();
  const body = codec.encode(payload);
  const headers = buildHeaders(opts);
  const attempts = opts.retry ? (validateRetry(opts.retry), opts.retry.attempts) : 1;
  const msgID = opts.msgId ?? (attempts > 1 ? globalThis.crypto.randomUUID() : undefined);
  const retryable = opts.retry?.retryable ?? isRetriablePublishError;

  for (let attempt = 1; ; attempt++) {
    try {
      return await js.publish(subject, body, { msgID, headers, timeout: opts.timeout });
    } catch (error) {
      if (attempt >= attempts || !retryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt, opts.retry?.backoff)));
    }
  }
}

export async function corePublish<S extends SubjectName>(
  subject: S,
  payload: PayloadOf<S>,
  opts: { headers?: Record<string, string> } & TraceOptions = {},
): Promise<void> {
  const { nc } = await getNats();
  nc.publish(subject, codec.encode(payload), { headers: buildHeaders(opts) });
}

export async function request<TReply = unknown, S extends SubjectName = SubjectName>(
  subject: S,
  payload?: PayloadOf<S>,
  opts: { timeout?: number; headers?: Record<string, string> } & TraceOptions = {},
): Promise<TReply> {
  const { nc } = await getNats();
  const reply = await nc.request(subject, payload === undefined ? undefined : codec.encode(payload), {
    timeout: opts.timeout ?? 5_000,
    headers: buildHeaders(opts),
  });
  return codec.tryDecodeJson<TReply>(reply.data) as TReply;
}
