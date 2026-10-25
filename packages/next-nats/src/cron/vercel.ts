import "server-only";
import { createHash } from "node:crypto";
import { getLogger } from "../logger.js";
import { invalidArgument } from "../errors.js";
import { loadVercelJsonText } from "../vercel-json.js";
import { defaultCron } from "./default.js";
import { validateSchedule, type CronJob, type CronRuntime } from "./runtime.js";

export const VERCEL_CRON_USER_AGENT = "vercel-cron/1.0";

export interface VercelCron {
  path: string;
  schedule: string;
}

export interface VercelCronsOptions {
  configPath?: string;
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
  runtime?: CronRuntime;
  fetch?: typeof fetch;
}

const DOMAIN = "next-nats.cron";
const MAX_VERCEL_CRONS = 100;
const NAMED_FIELD = /[A-Za-z]/;

function assertVercelSchedule(schedule: unknown, index: number): asserts schedule is string {
  const fields = typeof schedule === "string" ? schedule.trim().split(/\s+/) : [];
  if (fields.length !== 5) {
    throw invalidArgument(DOMAIN, "INVALID_VERCEL_CRON", `crons[${index}].schedule must be a five field cron expression`);
  }
  if (fields.some((field) => NAMED_FIELD.test(field))) {
    throw invalidArgument(DOMAIN, "INVALID_VERCEL_CRON", `crons[${index}].schedule does not support names such as MON or JAN`);
  }
  if (fields[2] !== "*" && fields[4] !== "*") {
    throw invalidArgument(DOMAIN, "INVALID_VERCEL_CRON", `crons[${index}].schedule cannot set both day of month and day of week`);
  }
  try {
    validateSchedule(fields.join(" "), "UTC");
  } catch (error) {
    throw invalidArgument(DOMAIN, "INVALID_VERCEL_CRON", `crons[${index}].schedule is not a valid cron expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readVercelCrons(configPath?: string): VercelCron[] {
  const text = loadVercelJsonText(configPath);
  if (text === undefined) return [];
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw invalidArgument(DOMAIN, "INVALID_VERCEL_CONFIG", `Cannot parse ${configPath ?? "vercel.json"}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const crons = (config as { crons?: unknown } | null)?.crons;
  if (crons === undefined) return [];
  if (!Array.isArray(crons)) throw invalidArgument(DOMAIN, "INVALID_VERCEL_CONFIG", `"crons" in ${configPath ?? "vercel.json"} must be an array`);
  if (crons.length > MAX_VERCEL_CRONS) {
    throw invalidArgument(DOMAIN, "INVALID_VERCEL_CRON", `"crons" in ${configPath ?? "vercel.json"} cannot define more than ${MAX_VERCEL_CRONS} cron jobs`);
  }
  return crons.map((entry, index) => {
    const { path, schedule } = (entry ?? {}) as Partial<VercelCron>;
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw invalidArgument(DOMAIN, "INVALID_VERCEL_CRON", `crons[${index}].path must be a string starting with "/"`);
    }
    assertVercelSchedule(schedule, index);
    return { path, schedule };
  });
}

export function vercelCronName(cron: VercelCron): string {
  const slug = cron.path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  const hash = createHash("sha1").update(`${cron.path}\n${cron.schedule}`).digest("hex").slice(0, 8);
  return `vercel_${slug || "root"}_${hash}`;
}

function defaultBaseUrl(): string {
  return process.env.NEXT_NATS_CRON_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
}

export function registerVercelCrons(options: VercelCronsOptions = {}): CronJob[] {
  const runtime = options.runtime ?? defaultCron();
  const call = options.fetch ?? fetch;
  return readVercelCrons(options.configPath).map((cron) =>
    runtime.defineCron({
      name: vercelCronName(cron),
      schedule: cron.schedule,
      timezone: "UTC",
      maxDeliver: 1,
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      onError: (error) => getLogger().error("vercel cron failed", { path: cron.path, error }),
      async handler({ signal }) {
        const secret = options.secret ?? process.env.CRON_SECRET;
        const response = await call(new URL(cron.path, options.baseUrl ?? defaultBaseUrl()), {
          method: "GET",
          redirect: "manual",
          signal,
          headers: {
            "user-agent": VERCEL_CRON_USER_AGENT,
            "x-vercel-cron-schedule": cron.schedule,
            ...(secret && { authorization: `Bearer ${secret}` }),
          },
        });
        await response.arrayBuffer().catch(() => undefined);
        if (response.status >= 400) throw new Error(`cron ${cron.path} responded with status ${response.status}`);
      },
    }),
  );
}
