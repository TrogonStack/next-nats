import "server-only";
import { createCronRuntime, type CronRuntime } from "./runtime.js";

const KEY = Symbol.for("next-nats.cron.default");

type Holder = { [KEY]?: CronRuntime };

export function defaultCron(): CronRuntime {
  const g = globalThis as Holder;
  return (g[KEY] ??= createCronRuntime());
}
