import "server-only";
import { DeliverPolicy, type OrderedConsumerOptions } from "@nats-io/jetstream";
import { codec } from "../codec.js";
import { getNats } from "../connection.js";
import { publicErrorResponse } from "../errors.js";
import { guardSubscriptions } from "../subscribe.js";
import type { StreamName, Subject } from "../values.js";
import { createSseResponse, lastEventSequence } from "./sse.js";
import { toSseEvent, type RealtimeMessage, type SseSubjectOptions } from "./subject.js";

export type DeliverFrom =
  | "new"
  | "last"
  | "all"
  | { startSeq: number }
  | { startTime: Date | string | number };

export interface SseStreamOptions<T = unknown> extends SseSubjectOptions<T> {
  stream: StreamName | string;
  filterSubjects?: Array<Subject | string>;
  deliver?: DeliverFrom;
  inactiveThreshold?: number;
}

export function deliverOptions(deliver: DeliverFrom): Partial<OrderedConsumerOptions> {
  if (deliver === "new") return { deliver_policy: DeliverPolicy.New };
  if (deliver === "last") return { deliver_policy: DeliverPolicy.Last };
  if (deliver === "all") return { deliver_policy: DeliverPolicy.All };
  if ("startSeq" in deliver) {
    return { deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: deliver.startSeq };
  }
  return {
    deliver_policy: DeliverPolicy.StartTime,
    opt_start_time: new Date(deliver.startTime).toISOString(),
  };
}

export async function sseFromStream<T = unknown>(request: Request, opts: SseStreamOptions<T>): Promise<Response> {
  const { nc, js } = await getNats();
  const resumeFrom = lastEventSequence(request);
  const deliver: DeliverFrom = resumeFrom !== undefined ? { startSeq: resumeFrom + 1 } : (opts.deliver ?? "new");
  const filters = opts.filterSubjects?.map(String);

  const consumer = await js.consumers.get(opts.stream, {
    ...deliverOptions(deliver),
    ...(filters?.length && { filter_subjects: filters }),
    inactive_threshold: opts.inactiveThreshold ?? 60_000,
  });
  let messages: Awaited<ReturnType<typeof consumer.consume>>;
  try {
    messages = await guardSubscriptions(nc, opts.stream, () => consumer.consume(), (live) => live.stop());
  } catch (error) {
    await consumer.delete().catch(() => undefined);
    return publicErrorResponse(error);
  }

  const release = async () => {
    messages.stop();
    await consumer.delete().catch(() => undefined);
  };

  if (request.signal.aborted) {
    await release();
    return new Response(null, { status: 499 });
  }

  return createSseResponse(request, opts, (sink) => {
    void (async () => {
      for await (const msg of messages) {
        if (sink.closed) break;
        const message: RealtimeMessage<T> = {
          subject: msg.subject,
          data: codec.tryDecodeJson<T>(msg.data) as T,
          payload: msg.data,
          headers: msg.headers,
          seq: msg.seq,
          timestamp: new Date(msg.info.timestampNanos / 1_000_000),
        };
        const event = await toSseEvent(message, opts, { id: msg.seq });
        if (event) await sink.send(event);
      }
    })().then(
      () => sink.close(),
      (error) => sink.fail(error),
    );
    return release;
  });
}
