import "server-only";
import type { MsgHdrs, Subscription } from "@nats-io/nats-core";
import { codec } from "../codec.js";
import { getNats } from "../connection.js";
import { publicErrorResponse } from "../errors.js";
import { subscribeConfirmed } from "../subscribe.js";
import type { Subject } from "../values.js";
import { createSseResponse, type SseEvent, type SseOptions } from "./sse.js";

export interface RealtimeMessage<T = unknown> {
  subject: string;
  data: T;
  payload: Uint8Array;
  headers?: MsgHdrs;
  seq?: number;
  timestamp?: Date;
}

export interface SseSubjectOptions<T = unknown> extends SseOptions {
  event?: string;
  filter?: (message: RealtimeMessage<T>) => boolean | Promise<boolean>;
  transform?: (message: RealtimeMessage<T>) => SseEvent | null | undefined | Promise<SseEvent | null | undefined>;
}

export async function toSseEvent<T>(
  message: RealtimeMessage<T>,
  opts: Pick<SseSubjectOptions<T>, "event" | "filter" | "transform">,
  base: SseEvent,
): Promise<SseEvent | undefined> {
  if (opts.filter && !(await opts.filter(message))) return undefined;
  if (!opts.transform) return { ...base, event: opts.event, data: message.data };
  const custom = await opts.transform(message);
  if (!custom) return undefined;
  return { ...base, event: opts.event, ...custom };
}

export async function sseFromSubject<T = unknown>(
  request: Request,
  subject: Subject | string,
  opts: SseSubjectOptions<T> = {},
): Promise<Response> {
  const { nc } = await getNats();
  let sub: Subscription;
  try {
    sub = await subscribeConfirmed(nc, String(subject));
  } catch (error) {
    return publicErrorResponse(error);
  }
  if (request.signal.aborted) {
    sub.unsubscribe();
    return new Response(null, { status: 499 });
  }
  return createSseResponse(request, opts, (sink) => {
    void (async () => {
      for await (const msg of sub) {
        if (sink.closed) break;
        const message: RealtimeMessage<T> = {
          subject: msg.subject,
          data: codec.tryDecodeJson<T>(msg.data) as T,
          payload: msg.data,
          headers: msg.headers,
        };
        const event = await toSseEvent(message, opts, {});
        if (event) await sink.send(event);
      }
    })().then(
      () => sink.close(),
      (error) => sink.fail(error),
    );
    return () => sub.unsubscribe();
  });
}
