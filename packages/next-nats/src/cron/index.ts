import "server-only";
import { createCronRuntime, type CronDefinition, type CronJob, type CronRuntime } from "./runtime.js";

export { createCronRuntime, nextOccurrence, validateSchedule } from "./runtime.js";
export type { CronContext, CronDefinition, CronJob, CronRuntime, CronRuntimeOptions } from "./runtime.js";
export { listCronRuns, recordCronRun } from "./runs.js";
export type { CronRun, CronRunStatus } from "./runs.js";

const KEY = Symbol.for("next-nats.cron.default");

type Holder = { [KEY]?: CronRuntime };

export function defaultCron(): CronRuntime {
  const g = globalThis as Holder;
  return (g[KEY] ??= createCronRuntime());
}

export function defineCron(def: CronDefinition): CronJob {
  return defaultCron().defineCron(def);
}

export function stopAllCrons(): Promise<void> {
  return defaultCron().stop();
}

export function triggerCron(name: string, at?: Date): Promise<{ duplicate: boolean }> {
  return defaultCron().trigger(name, at);
}
