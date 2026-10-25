import "server-only";
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { AckPolicy, JetStreamApiCodes, JetStreamApiError, RetentionPolicy, type ConsumerConfig, type ConsumerMessages, type JsMsg } from "@nats-io/jetstream";
import { codec } from "../codec.js";
import { getNats, getNatsConfig, onNatsShutdown } from "../connection.js";
import { ensureStream } from "../streams.js";
import { recordCronRun } from "./runs.js";

const NANOS_PER_MS = 1_000_000;
const NAME = /^[A-Za-z0-9_-]+$/;

export interface CronContext {
  name: string;
  scheduledAt: Date;
  deliveryCount: number;
  replica: string;
  signal: AbortSignal;
}

export interface CronDefinition {
  name: string;
  schedule: string;
  timezone?: string;
  handler: (context: CronContext) => void | Promise<void>;
  timeoutMs?: number;
  maxDeliver?: number;
  retryDelayMs?: number;
  maxLatenessMs?: number;
  concurrency?: number;
  record?: boolean;
  onError?: (error: unknown, context?: CronContext) => void;
}

export interface CronJob {
  readonly name: string;
  readonly schedule: string;
  nextRun(from?: Date): Date;
  trigger(at?: Date): Promise<{ duplicate: boolean }>;
  stop(): Promise<void>;
}

export interface CronRuntimeOptions {
  stream?: string;
  prefix?: string;
  duplicateWindowMs?: number;
  replica?: string;
}

interface TickPayload {
  name: string;
  scheduledFor: number;
}

export function nextOccurrence(schedule: string, from: Date, timezone?: string): Date {
  return CronExpressionParser.parse(schedule, { currentDate: from, ...(timezone && { tz: timezone }) })
    .next()
    .toDate();
}

export function validateSchedule(schedule: string, timezone?: string): void {
  nextOccurrence(schedule, new Date(), timezone);
}

export interface CronRuntime {
  readonly replica: string;
  defineCron(def: CronDefinition): CronJob;
  trigger(name: string, at?: Date): Promise<{ duplicate: boolean }>;
  stop(): Promise<void>;
}

function sleepUntil(target: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const tick = () => {
      const remaining = target - Date.now();
      if (remaining <= 0 || signal.aborted) return resolve();
      timer = setTimeout(tick, Math.min(remaining, 15_000));
      timer.unref();
    };
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    tick();
  });
}

export function createCronRuntime(options: CronRuntimeOptions = {}): CronRuntime {
  const stream = options.stream ?? "CRON";
  const prefix = options.prefix ?? "cron";
  const replica = options.replica ?? `${process.pid}-${randomUUID().slice(0, 8)}`;
  const duplicateWindowMs = options.duplicateWindowMs ?? 5 * 60_000;
  const jobs = new Map<string, CronJob>();
  let ready: Promise<unknown> | undefined;

  const provision = () =>
    (ready ??= ensureStream({
      name: stream,
      subjects: [`${prefix}.>`],
      retention: RetentionPolicy.Limits,
      max_age: 24 * 3_600 * 1_000 * NANOS_PER_MS,
      duplicate_window: duplicateWindowMs * NANOS_PER_MS,
    }).catch((error) => {
      ready = undefined;
      throw error;
    }));

  const trigger = async (name: string, at: Date = new Date()) => {
    await provision();
    const { js } = await getNats();
    const payload: TickPayload = { name, scheduledFor: at.getTime() };
    const ack = await js.publish(`${prefix}.${name}`, codec.encodeJson(payload), { msgID: `${name}:${at.getTime()}` });
    return { duplicate: ack.duplicate };
  };

  const defineCron = (def: CronDefinition): CronJob => {
    if (!NAME.test(def.name)) throw new TypeError(`Invalid cron name "${def.name}": use letters, digits, "-" and "_"`);
    validateSchedule(def.schedule, def.timezone);
    const existing = jobs.get(def.name);
    if (existing) return existing;

    const tickSubject = `${prefix}.${def.name}`;
    const timeoutMs = def.timeoutMs ?? 5 * 60_000;
    const maxDeliver = def.maxDeliver ?? 3;
    const retryDelayMs = def.retryDelayMs ?? 5_000;
    const maxLateness = def.maxLatenessMs ?? 5 * 60_000;
    const abort = new AbortController();
    let iterator: ConsumerMessages | undefined;

    const publishTick = (at: Date) => trigger(def.name, at);

    const provisionConsumer = async () => {
      await provision();
      const { jsm } = await getNats();
      const durable = `cron_${def.name}`;
      try {
        await jsm.consumers.info(stream, durable);
      } catch (err) {
        if (!(err instanceof JetStreamApiError) || err.code !== JetStreamApiCodes.ConsumerNotFound) throw err;
        const config: Partial<ConsumerConfig> = {
          durable_name: durable,
          ack_policy: AckPolicy.Explicit,
          ack_wait: 30_000 * NANOS_PER_MS,
          max_deliver: maxDeliver,
          max_ack_pending: def.concurrency ?? 1,
          filter_subject: tickSubject,
        };
        await jsm.consumers.add(stream, config);
      }
      return durable;
    };

    const execute = async (msg: JsMsg) => {
      const tick = codec.decodeJson<TickPayload>(msg.data);
      const scheduledAt = new Date(tick.scheduledFor);
      const startedAt = new Date();
      const base = { name: def.name, scheduledAt: scheduledAt.toISOString(), replica, deliveryCount: msg.info.deliveryCount };
      const save = (status: "success" | "failed" | "skipped", error?: string) =>
        def.record === false
          ? Promise.resolve()
          : recordCronRun({ ...base, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), status, ...(error && { error }) }).catch(() => undefined);

      if (startedAt.getTime() - tick.scheduledFor > maxLateness) {
        msg.ack();
        await save("skipped", "tick expired before it could run");
        return;
      }
      const heartbeat = setInterval(() => {
        try {
          msg.working();
        } catch {
          return;
        }
      }, 10_000);
      const context: CronContext = {
        name: def.name,
        scheduledAt,
        deliveryCount: msg.info.deliveryCount,
        replica,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]),
      };
      try {
        await Promise.race([
          def.handler(context),
          new Promise<never>((_, reject) => context.signal.addEventListener("abort", () => reject(new Error(`cron "${def.name}" aborted or timed out`)), { once: true })),
        ]);
        msg.ack();
        await save("success");
      } catch (error) {
        def.onError?.(error, context);
        const message = error instanceof Error ? error.message : String(error);
        if (msg.info.deliveryCount >= maxDeliver) {
          msg.term(message);
          await save("failed", message);
        } else {
          msg.nak(retryDelayMs);
        }
      } finally {
        clearInterval(heartbeat);
      }
    };

    const consumeLoop = async () => {
      let retry = 1_000;
      while (!abort.signal.aborted) {
        try {
          const durable = await provisionConsumer();
          const { js } = await getNats();
          const consumer = await js.consumers.get(stream, durable);
          iterator = await consumer.consume({ max_messages: 1, idle_heartbeat: 5_000 });
          retry = 1_000;
          for await (const msg of iterator) {
            if (abort.signal.aborted) {
              msg.nak();
              break;
            }
            await execute(msg);
          }
        } catch (error) {
          if (abort.signal.aborted) break;
          def.onError?.(error);
          await new Promise((resolve) => setTimeout(resolve, retry));
          retry = Math.min(retry * 2, 30_000);
        }
      }
    };

    const tickLoop = async () => {
      let cursor = new Date();
      while (!abort.signal.aborted) {
        const at = nextOccurrence(def.schedule, cursor, def.timezone);
        await sleepUntil(at.getTime(), abort.signal);
        if (abort.signal.aborted) break;
        try {
          await publishTick(at);
        } catch (error) {
          def.onError?.(error);
        }
        cursor = at;
      }
    };

    const job: CronJob = {
      name: def.name,
      schedule: def.schedule,
      nextRun: (from = new Date()) => nextOccurrence(def.schedule, from, def.timezone),
      trigger: (at = new Date()) => publishTick(at),
      async stop() {
        abort.abort();
        jobs.delete(def.name);
        await iterator?.close().catch(() => undefined);
        await Promise.allSettled(loops);
      },
    };
    const loops: Promise<void>[] = [];
    jobs.set(def.name, job);
    if (getNatsConfig().workers) {
      loops.push(consumeLoop(), tickLoop());
      onNatsShutdown(() => job.stop());
    }
    return job;
  };

  return {
    replica,
    defineCron,
    trigger,
    async stop() {
      await Promise.all([...jobs.values()].map((job) => job.stop()));
    },
  };
}
