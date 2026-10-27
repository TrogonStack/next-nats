import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import { onNatsStatus } from "./connection.js";
import { Code, SpecError, Visibility } from "./errors.js";
import { getLogger } from "./logger.js";

const REJECTION = /maximum subscriptions|permissions violation for subscription/i;

export async function guardSubscriptions<T>(
  nc: NatsConnection,
  subject: string,
  work: () => Promise<T>,
  undo: (result: T) => void | Promise<void>,
): Promise<T> {
  let rejection: Error | undefined;
  const stop = onNatsStatus((event) => {
    if (event.type === "error" && event.error && REJECTION.test(event.error.message)) rejection ??= event.error;
  });
  let result: T;
  try {
    result = await work();
    await nc.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    stop();
  }
  if (!rejection) return result;
  await Promise.resolve(undo(result)).catch(() => undefined);
  getLogger().error("subscription rejected by the server", { subject, error: rejection });
  throw new SpecError({
    code: Code.UNAVAILABLE,
    domain: "next-nats.subscribe",
    reason: "SUBSCRIPTION_REJECTED",
    message: "The server rejected the subscription",
    visibility: Visibility.PUBLIC,
    subject,
    cause: rejection,
  });
}

export const subscribeConfirmed = (nc: NatsConnection, subject: string): Promise<Subscription> =>
  guardSubscriptions(nc, subject, async () => nc.subscribe(subject), (sub) => sub.unsubscribe());
