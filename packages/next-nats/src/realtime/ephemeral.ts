import "server-only";
import type { JsMsg } from "@nats-io/jetstream";
import { getNats } from "../connection.js";
import type { StreamName, Subject } from "../values.js";
import { deliverOptions, type DeliverFrom } from "./stream.js";

export type EphemeralOutcome = "aborted" | "timeout" | "ended";

export interface EphemeralConsumeOptions {
  stream: StreamName | string;
  filterSubjects?: Array<Subject | string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  deliver?: DeliverFrom;
  inactiveThreshold?: number;
  handler: (msg: JsMsg) => void | Promise<void>;
  onError?: (error: unknown, msg?: JsMsg) => void;
}

export async function consumeEphemeral(opts: EphemeralConsumeOptions): Promise<EphemeralOutcome> {
  if (opts.signal?.aborted) return "aborted";
  const { js } = await getNats();
  const filters = opts.filterSubjects?.map(String);

  const consumer = await js.consumers.get(opts.stream, {
    ...deliverOptions(opts.deliver ?? "new"),
    ...(filters?.length && { filter_subjects: filters }),
    inactive_threshold: opts.inactiveThreshold ?? 60_000,
  });

  let outcome: EphemeralOutcome = "ended";
  let finished = false;
  let messages: Awaited<ReturnType<typeof consumer.consume>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = (reason: EphemeralOutcome) => {
    if (finished) return;
    finished = true;
    outcome = reason;
    messages?.stop();
  };
  const onAbort = () => stop("aborted");

  try {
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => stop("timeout"), opts.timeoutMs);
      timer.unref?.();
    }
    messages = await consumer.consume();
    if (opts.signal?.aborted) stop("aborted");
    if (finished) messages.stop();

    for await (const msg of messages) {
      if (finished) break;
      try {
        await opts.handler(msg);
      } catch (error) {
        try {
          opts.onError?.(error, msg);
        } catch {
          /* an error hook must not end the stream */
        }
      }
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    finished = true;
    messages?.stop();
    await consumer.delete().catch(() => undefined);
  }
}
