import "server-only";
import { headers as natsHeaders, type MsgHdrs } from "@nats-io/nats-core";
import type { PubAck } from "@nats-io/jetstream";
import { codec } from "./codec.js";
import { getNats } from "./connection.js";
import type { Subject } from "./values.js";

export interface NatsEvents {}

export type SubjectName = (keyof NatsEvents & string) | Subject | (string & {});

export type PayloadOf<S extends string> = S extends keyof NatsEvents ? NatsEvents[S] : unknown;

export interface PublishOptions {
  msgId?: string;
  headers?: Record<string, string>;
  traceparent?: string;
  timeout?: number;
}

function buildHeaders(opts: PublishOptions): MsgHdrs | undefined {
  if (!opts.headers && !opts.traceparent) return undefined;
  const h = natsHeaders();
  for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k, v);
  if (opts.traceparent) h.set("traceparent", opts.traceparent);
  return h;
}

export async function jsPublish<S extends SubjectName>(
  subject: S,
  payload: PayloadOf<S>,
  opts: PublishOptions = {},
): Promise<PubAck> {
  const { js } = await getNats();
  return js.publish(subject, codec.encode(payload), {
    msgID: opts.msgId,
    headers: buildHeaders(opts),
    timeout: opts.timeout,
  });
}

export async function corePublish<S extends SubjectName>(
  subject: S,
  payload: PayloadOf<S>,
  opts: Omit<PublishOptions, "msgId" | "timeout"> = {},
): Promise<void> {
  const { nc } = await getNats();
  nc.publish(subject, codec.encode(payload), { headers: buildHeaders(opts) });
}

export async function request<TReply = unknown, S extends SubjectName = SubjectName>(
  subject: S,
  payload?: PayloadOf<S>,
  opts: { timeout?: number; headers?: Record<string, string>; traceparent?: string } = {},
): Promise<TReply> {
  const { nc } = await getNats();
  const reply = await nc.request(subject, payload === undefined ? undefined : codec.encode(payload), {
    timeout: opts.timeout ?? 5_000,
    headers: buildHeaders(opts),
  });
  return codec.tryDecodeJson<TReply>(reply.data) as TReply;
}
