import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getNats, getNatsConfig, onNatsShutdown } from "../connection.js";
import { getLogger } from "../logger.js";
import { internalsOf, QueueClient } from "./client.js";
import { runConsumerLoop, type ConsumerLoop } from "./consumer.js";
import { ackLease, clampVisibility, DEFAULT_RETRY_AFTER_SECONDS, encodeReceipt, processDelivery } from "./delivery.js";
import { CLOUD_EVENT_TYPE_V2BETA } from "./callback.js";
import { resolveStore, type QueueStore, type QueueStoreOptions, type StoredMessage } from "./store.js";
import { bufferToStream } from "./transport.js";
import type { MessageHandler, RetryHandler } from "./types.js";
import type { ExperimentalCoalescedReruns } from "./types.js";

export interface QueueTrigger {
  filePath: string;
  topic: string;
  consumerGroup: string;
  path: string;
  retryAfterSeconds: number;
  initialDelaySeconds: number;
}

interface VercelJsonTrigger {
  type?: string;
  topic?: string;
  retryAfterSeconds?: number;
  initialDelaySeconds?: number;
}

interface VercelJson {
  functions?: Record<string, { experimentalTriggers?: VercelJsonTrigger[] }>;
}

export function filePathToConsumerGroup(filePath: string): string {
  let result = "";
  for (const char of filePath) {
    if (char === "_") result += "__";
    else if (char === "/") result += "_S";
    else if (char === ".") result += "_D";
    else if (/[A-Za-z0-9-]/.test(char)) result += char;
    else result += "_" + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
  }
  return result;
}

const ROUTE_FILE = /\/route\.(?:[cm]?[jt]sx?)$/;
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;

export function routePathOf(filePath: string): string | undefined {
  let path = filePath.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^src\//, "");
  if (path.startsWith("app/")) {
    path = path.slice(3).replace(ROUTE_FILE, "");
    path = path
      .split("/")
      .filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith("@"))
      .join("/");
  } else if (path.startsWith("pages/")) {
    path = path.slice(5).replace(SOURCE_EXT, "").replace(/\/index$/, "");
  } else {
    path = `/${path.replace(SOURCE_EXT, "")}`;
  }
  if (/[\[\]*]/.test(path)) return undefined;
  return path === "" ? "/" : path;
}

export function loadTriggers(config: VercelJson): QueueTrigger[] {
  const out: QueueTrigger[] = [];
  for (const [filePath, fn] of Object.entries(config.functions ?? {})) {
    for (const trigger of fn.experimentalTriggers ?? []) {
      if (!trigger.type?.startsWith("queue/") || !trigger.topic) continue;
      if (trigger.type !== "queue/v2beta") {
        getLogger().warning(`unsupported queue trigger type "${trigger.type}" for topic "${trigger.topic}" in ${filePath}, use "queue/v2beta"`);
        continue;
      }
      const path = routePathOf(filePath);
      if (!path) {
        getLogger().warning(`queue trigger for ${filePath} maps to a dynamic route and cannot be called by the worker`);
        continue;
      }
      out.push({
        filePath,
        topic: trigger.topic,
        consumerGroup: filePathToConsumerGroup(filePath),
        path,
        retryAfterSeconds: trigger.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
        initialDelaySeconds: trigger.initialDelaySeconds ?? 0,
      });
    }
  }
  return out;
}

export function readVercelJson(cwd = process.cwd()): VercelJson {
  const file = join(cwd, "vercel.json");
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as VercelJson;
}

export interface QueueWorkerOptions {
  vercelJson?: VercelJson;
  baseUrl?: string;
  concurrency?: number;
  visibilityTimeoutSeconds?: number;
  nats?: QueueStoreOptions;
  fetch?: typeof fetch;
}

export interface QueueWorker {
  readonly triggers: readonly QueueTrigger[];
  stop(): Promise<void>;
}

const noWorker: QueueWorker = { triggers: [], stop: async () => {} };

function callbackHeaders(trigger: QueueTrigger, stored: StoredMessage, ackWait: number): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(stored.headers)) {
    try {
      headers.set(name, value);
    } catch {
      continue;
    }
  }
  headers.set("content-type", stored.contentType);
  headers.set("ce-specversion", "1.0");
  headers.set("ce-id", `${stored.messageId}:${stored.deliveryCount}`);
  headers.set("ce-source", `/queues/${stored.topic}/consumer-groups/${trigger.consumerGroup}`);
  headers.set("ce-type", CLOUD_EVENT_TYPE_V2BETA);
  headers.set("ce-vqsqueuename", stored.topic);
  headers.set("ce-vqsconsumergroup", trigger.consumerGroup);
  headers.set("ce-vqsmessageid", stored.messageId);
  headers.set("ce-vqsregion", stored.region);
  headers.set("ce-vqsreceipthandle", encodeReceipt(stored.reply));
  headers.set("ce-vqsdeliverycount", String(stored.deliveryCount));
  headers.set("ce-vqscreatedat", stored.createdAt.toISOString());
  headers.set("ce-vqsexpiresat", stored.expiresAt.toISOString());
  headers.set("ce-vqsvisibilitydeadline", new Date(Date.now() + ackWait * 1000).toISOString());
  return headers;
}

function baseUrlOf(options: QueueWorkerOptions): string {
  return (options.baseUrl ?? process.env.NATS_QUEUE_CALLBACK_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`).replace(/\/+$/, "");
}

async function deliverToRoute(trigger: QueueTrigger, stored: StoredMessage, store: QueueStore, base: string, ackWait: number, doFetch: typeof fetch): Promise<void> {
  const { nc } = await getNats();
  const lease = ackLease(nc, stored.reply);
  const initialDelayMs = stored.visibleAt.getTime() + trigger.initialDelaySeconds * 1000 - Date.now();
  if (initialDelayMs > 0) {
    await lease.retryIn(initialDelayMs / 1000);
    return;
  }
  void store;
  try {
    const response = await doFetch(`${base}${trigger.path}`, {
      method: "POST",
      headers: callbackHeaders(trigger, stored, ackWait),
      body: stored.body as BodyInit,
      signal: AbortSignal.timeout(ackWait * 1000),
    });
    await response.arrayBuffer().catch(() => undefined);
    if (response.ok) return;
    getLogger().warning("queue callback was not accepted", { status: response.status, path: trigger.path, messageId: stored.messageId });
  } catch (error) {
    getLogger().warning("queue callback failed", { error, path: trigger.path, messageId: stored.messageId });
  }
  await lease.retryIn(trigger.retryAfterSeconds);
}

const WORKERS_KEY = Symbol.for("next-nats.queue.workers");

function activeKeys(): Map<string, { stop(): Promise<void> }> {
  const holder = globalThis as Record<symbol, Map<string, { stop(): Promise<void> }> | undefined>;
  return (holder[WORKERS_KEY] ??= new Map());
}

export function startQueueWorker(options: QueueWorkerOptions = {}): QueueWorker {
  if (!getNatsConfig().workers) return noWorker;
  const triggers = loadTriggers(options.vercelJson ?? readVercelJson());
  if (triggers.length === 0) return noWorker;
  const store = resolveStore(options.nats);
  const base = baseUrlOf(options);
  const ackWait = clampVisibility(options.visibilityTimeoutSeconds);
  const doFetch = options.fetch ?? fetch;
  const loops: ConsumerLoop[] = [];
  const keys: string[] = [];
  const used: QueueTrigger[] = [];
  for (const trigger of triggers) {
    const key = `${store.stream}/${trigger.topic}/${trigger.consumerGroup}`;
    if (activeKeys().has(key)) continue;
    const loop = runConsumerLoop({
      store,
      pattern: trigger.topic,
      group: trigger.consumerGroup,
      ackWaitSeconds: ackWait,
      concurrency: Math.max(1, options.concurrency ?? 10),
      onMessage: (stored) => deliverToRoute(trigger, stored, store, base, ackWait, doFetch),
    });
    activeKeys().set(key, loop);
    keys.push(key);
    loops.push(loop);
    used.push(trigger);
  }
  const worker: QueueWorker = {
    triggers: used,
    async stop() {
      for (const key of keys) activeKeys().delete(key);
      await Promise.all(loops.map((loop) => loop.stop()));
    },
  };
  onNatsShutdown(() => worker.stop());
  return worker;
}

export interface RegisterDevConsumerOptions extends ExperimentalCoalescedReruns {
  topic: string;
  client: QueueClient;
  handler: MessageHandler;
  consumerGroup?: string;
  visibilityTimeoutSeconds?: number;
  retry?: RetryHandler;
}

export function registerDevConsumer(options: RegisterDevConsumerOptions): () => void {
  if (!getNatsConfig().workers) return () => {};
  const { topic, client, handler, consumerGroup = "dev-consumer", retry } = options;
  const self = internalsOf(client);
  const store = self.store();
  const ackWait = clampVisibility(options.visibilityTimeoutSeconds);
  const key = `${store.stream}/${topic}/${consumerGroup}`;
  void activeKeys().get(key)?.stop();
  const loop = runConsumerLoop({
    store,
    pattern: topic,
    group: consumerGroup,
    ackWaitSeconds: ackWait,
    concurrency: 1,
    onMessage: async (stored) => {
      const { nc } = await getNats();
      const lease = ackLease(nc, stored.reply);
      try {
        await processDelivery(handler, {
          topicName: stored.topic,
          consumerGroup,
          region: stored.region,
          message: {
            messageId: stored.messageId,
            payload: await self.transport.deserialize(bufferToStream(stored.body)),
            deliveryCount: stored.deliveryCount,
            createdAt: stored.createdAt,
            expiresAt: stored.expiresAt,
            contentType: stored.contentType,
            receiptHandle: encodeReceipt(stored.reply),
          },
          lease,
          visibilityTimeoutSeconds: ackWait,
          retry,
          transport: self.transport,
        });
      } catch {
        await lease.retryIn(DEFAULT_RETRY_AFTER_SECONDS);
      }
    },
  });
  const entry = { stop: () => loop.stop() };
  activeKeys().set(key, entry);
  return () => {
    if (activeKeys().get(key) === entry) activeKeys().delete(key);
    void loop.stop();
  };
}
