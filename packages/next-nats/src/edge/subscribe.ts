import type { MsgHdrs } from "@nats-io/nats-core";
import { codec } from "../codec.js";
import { createSseResponse, type SseEvent, type SseOptions } from "../realtime/sse.js";
import type { SubjectName } from "../publish-core.js";
import { getEdgeNats } from "./connection.js";

export interface EdgeMessage<T = unknown> {
  subject: string;
  data: T;
  payload: Uint8Array;
  headers?: MsgHdrs;
}

export interface EdgeSubscribeOptions {
  signal?: AbortSignal;
  queue?: string;
}

export interface EdgeSseOptions<T = unknown> extends SseOptions, Pick<EdgeSubscribeOptions, "queue"> {
  event?: string;
  filter?: (message: EdgeMessage<T>) => boolean;
  transform?: (message: EdgeMessage<T>) => SseEvent | null | undefined;
}

export async function edgeSubscribe<T = unknown>(
  subject: SubjectName,
  opts: EdgeSubscribeOptions = {},
): Promise<ReadableStream<EdgeMessage<T>>> {
  const { nc } = await getEdgeNats();
  const { signal } = opts;
  let unsubscribe = () => {};
  return new ReadableStream<EdgeMessage<T>>(
    {
      start(controller) {
        if (signal?.aborted) {
          controller.close();
          return;
        }
        const sub = nc.subscribe(subject, {
          queue: opts.queue,
          callback: (error, msg) => {
            if (error) {
              controller.error(error);
              unsubscribe();
              return;
            }
            controller.enqueue({ subject: msg.subject, data: codec.tryDecodeJson<T>(msg.data) as T, payload: msg.data, headers: msg.headers });
          },
        });
        const stop = () => {
          sub.unsubscribe();
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          stop();
          try {
            controller.close();
          } catch {
            /* already closed or errored */
          }
        };
        unsubscribe = stop;
        signal?.addEventListener("abort", onAbort, { once: true });
      },
      cancel() {
        unsubscribe();
      },
    },
    { highWaterMark: 64 },
  );
}

export async function edgeSseFromSubject<T = unknown>(
  request: Request,
  subject: SubjectName,
  opts: EdgeSseOptions<T> = {},
): Promise<Response> {
  const { nc } = await getEdgeNats();
  return createSseResponse(request, opts, (sink) => {
    const sub = nc.subscribe(subject, {
      queue: opts.queue,
      callback: (error, msg) => {
        if (error) {
          sink.fail(error);
          return;
        }
        if (sink.closed) return;
        const message: EdgeMessage<T> = { subject: msg.subject, data: codec.tryDecodeJson<T>(msg.data) as T, payload: msg.data, headers: msg.headers };
        if (opts.filter && !opts.filter(message)) return;
        const custom = opts.transform ? opts.transform(message) : { data: message.data };
        if (!custom) return;
        void sink.send({ event: opts.event, ...custom }).catch((e) => sink.fail(e));
      },
    });
    return () => sub.unsubscribe();
  });
}
