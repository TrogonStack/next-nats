import "server-only";
import { defaultCron } from "./default.js";
import type { CronDefinition, CronJob } from "./runtime.js";

export { createCronRuntime, nextOccurrence, validateSchedule } from "./runtime.js";
export type { CronContext, CronDefinition, CronJob, CronRuntime, CronRuntimeOptions } from "./runtime.js";
export { listCronRuns, recordCronRun } from "./runs.js";
export type { CronRun, CronRunStatus } from "./runs.js";

export { defaultCron } from "./default.js";
export { readVercelCrons, registerVercelCrons, vercelCronName, VERCEL_CRON_USER_AGENT } from "./vercel.js";
export type { VercelCron, VercelCronsOptions } from "./vercel.js";

export function defineCron(def: CronDefinition): CronJob {
  return defaultCron().defineCron(def);
}

export function stopAllCrons(): Promise<void> {
  return defaultCron().stop();
}

export function triggerCron(name: string, at?: Date): Promise<{ duplicate: boolean }> {
  return defaultCron().trigger(name, at);
}
