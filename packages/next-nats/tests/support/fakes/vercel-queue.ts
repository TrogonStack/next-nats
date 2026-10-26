import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

const NAME = /^[A-Za-z0-9_-]+$/;
const DAY_MS = 86_400_000;
const MAX_RETENTION_SECONDS = 604_800;
const MIN_RETENTION_SECONDS = 60;
const DEFAULT_VISIBILITY_SECONDS = 60;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const DISPATCH_VISIBILITY_SECONDS = 300;
const TICK_MS = 25;

interface StoredMessage {
  id: string;
  topic: string;
  body: Buffer;
  contentType: string;
  headers: Record<string, string>;
  createdAt: number;
  expiresAt: number;
  visibleAt: number;
}

interface Delivery {
  deliveryCount: number;
  invisibleUntil: number;
  done: boolean;
}

interface Lease {
  groupKey: string;
  messageId: string;
}

export interface FakeTrigger {
  topic: string;
  consumerGroup: string;
  url: string;
  retryAfterSeconds?: number;
  initialDelaySeconds?: number;
  maxDeliveries?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface RecordedDispatch {
  messageId: string;
  deliveryCount: number;
  status: number;
  responseBody: string;
  requestHeaders: Record<string, string>;
}

export interface FakeQueueOptions {
  token?: string;
}

function matchesTopic(pattern: string, topic: string): boolean {
  return pattern.endsWith("*") ? topic.startsWith(pattern.slice(0, -1)) : pattern === topic;
}

function flatten(request: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function parseMultipart(body: Buffer, contentType: string): Array<{ headers: Record<string, string>; body: Buffer }> {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) return [];
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Array<{ headers: Record<string, string>; body: Buffer }> = [];
  let cursor = body.indexOf(delimiter);
  while (cursor !== -1) {
    const start = cursor + delimiter.length;
    if (body.subarray(start, start + 2).toString() === "--") break;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    const part = body.subarray(start + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const headerText = part.subarray(0, split).toString();
    const headers: Record<string, string> = {};
    for (const line of headerText.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    parts.push({ headers, body: part.subarray(split + 4) });
    cursor = next;
  }
  return parts;
}

export class FakeVercelQueue {
  readonly requests: RecordedRequest[] = [];
  readonly dispatches: RecordedDispatch[] = [];
  readonly token: string;
  private server?: Server;
  private timer?: ReturnType<typeof setInterval>;
  private readonly messages: StoredMessage[] = [];
  private readonly groups = new Map<string, Map<string, Delivery>>();
  private readonly leases = new Map<string, Lease>();
  private readonly idempotency = new Set<string>();
  private readonly triggers: FakeTrigger[] = [];
  private readonly inFlightDispatch = new Set<string>();
  origin = "";

  constructor(options: FakeQueueOptions = {}) {
    this.token = options.token ?? "fake-queue-token";
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error) => json(response, 500, { error: String(error) }));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.timer = setInterval(() => void this.dispatch(), TICK_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections();
  }

  clientOptions() {
    return { resolveBaseUrl: () => new URL(this.origin), token: this.token, deploymentId: null, region: "iad1" } as const;
  }

  addTrigger(trigger: FakeTrigger): void {
    this.triggers.push(trigger);
  }

  reset(): void {
    this.requests.length = 0;
    this.dispatches.length = 0;
    this.messages.length = 0;
    this.groups.clear();
    this.leases.clear();
    this.idempotency.clear();
    this.triggers.length = 0;
  }

  private groupKey(pattern: string, group: string): string {
    return `${pattern}|${group}`;
  }

  private deliveriesOf(key: string): Map<string, Delivery> {
    let found = this.groups.get(key);
    if (!found) {
      found = new Map();
      this.groups.set(key, found);
    }
    return found;
  }

  private store(topic: string, body: Buffer, headers: Record<string, string>): { status: number; body: unknown } {
    if (!NAME.test(topic)) return { status: 400, body: { error: `Invalid topic name: ${topic}` } };
    const retention = headers["vqs-retention-seconds"] === undefined ? DAY_MS / 1000 : Number(headers["vqs-retention-seconds"]);
    const delay = headers["vqs-delay-seconds"] === undefined ? 0 : Number(headers["vqs-delay-seconds"]);
    if (!Number.isInteger(retention) || retention < MIN_RETENTION_SECONDS || retention > MAX_RETENTION_SECONDS) {
      return { status: 400, body: { error: "Invalid retention seconds" } };
    }
    if (!Number.isInteger(delay) || delay < 0 || delay > MAX_RETENTION_SECONDS) {
      return { status: 400, body: { error: "Invalid delay seconds" } };
    }
    const id = `msg_${randomUUID()}`;
    const key = headers["vqs-idempotency-key"];
    if (key !== undefined && key.length > 256) return { status: 400, body: { error: "Invalid idempotency key" } };
    // Assumption: a duplicate idempotency key is answered like a fresh send with a new id and then dropped. The docs only say SendMessage always succeeds.
    const duplicate = key !== undefined && this.idempotency.has(`${topic}\0${key}`);
    if (key !== undefined) this.idempotency.add(`${topic}\0${key}`);
    if (!duplicate) {
      const custom: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) {
        if (!["authorization", "content-type", "content-length", "host", "connection", "accept", "accept-encoding", "user-agent", "accept-language", "sec-fetch-mode"].includes(name) && !name.startsWith("vqs-")) custom[name] = value;
      }
      const now = Date.now();
      this.messages.push({
        id,
        topic,
        body,
        contentType: headers["content-type"] ?? "application/octet-stream",
        headers: custom,
        createdAt: now,
        expiresAt: now + retention * 1000,
        visibleAt: now + delay * 1000,
      });
    }
    return { status: 201, body: { messageId: id } };
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.origin);
    const body = await readBody(request);
    const headers = flatten(request);
    this.requests.push({ method: request.method ?? "GET", path: url.pathname, headers, body });
    if (headers.authorization !== `Bearer ${this.token}`) {
      json(response, 401, { error: "Missing or invalid authentication token" });
      return;
    }
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments[0] !== "api" || segments[1] !== "v3" || segments[2] !== "topic" || !segments[3]) {
      json(response, 404, { error: "Not found" });
      return;
    }
    const topic = segments[3];
    const rest = segments.slice(4);
    const method = request.method;
    if (method === "POST" && rest.length === 0) {
      const result = this.store(topic, body, headers);
      json(response, result.status, result.body);
      return;
    }
    if (method === "POST" && rest.length === 1 && rest[0] === "batch") {
      const parts = parseMultipart(body, headers["content-type"] ?? "");
      // Assumption: the batch endpoint answers 200 with per-message results in request order.
      const results = parts.map((part) => {
        const stored = this.store(topic, part.body, part.headers);
        if (stored.status === 201) return { status: "sent", messageId: (stored.body as { messageId: string }).messageId };
        return { status: "failed", statusCode: stored.status, error: (stored.body as { error: string }).error, retryable: false };
      });
      json(response, 200, { results });
      return;
    }
    if (rest[0] !== "consumer" || !rest[1]) {
      json(response, 404, { error: "Not found" });
      return;
    }
    const group = rest[1];
    if (!NAME.test(topic) || !NAME.test(group)) {
      json(response, 400, { error: "Invalid topic or consumer group name" });
      return;
    }
    if (method === "POST" && rest.length === 2) {
      this.receive(topic, group, headers, response);
      return;
    }
    if (rest[2] === "lease" && rest[3]) {
      const lease = this.leases.get(rest[3]);
      if (!lease) {
        json(response, 404, { error: "Message not found or already acknowledged" });
        return;
      }
      const delivery = this.deliveriesOf(lease.groupKey).get(lease.messageId)!;
      if (method === "DELETE") {
        delivery.done = true;
        this.leases.delete(rest[3]);
        response.writeHead(204).end();
        return;
      }
      if (method === "PATCH") {
        const seconds = Number((JSON.parse(body.toString() || "{}") as { visibilityTimeoutSeconds?: number }).visibilityTimeoutSeconds);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3_600) {
          json(response, 400, { error: "Invalid visibility timeout" });
          return;
        }
        delivery.invisibleUntil = Date.now() + seconds * 1000;
        json(response, 200, { success: true });
        return;
      }
    }
    json(response, 404, { error: "Not found" });
  }

  private ready(pattern: string, key: string, now: number, initialDelayMs = 0): StoredMessage[] {
    const deliveries = this.deliveriesOf(key);
    return this.messages.filter((message) => {
      if (!matchesTopic(pattern, message.topic) || message.expiresAt <= now || message.visibleAt + initialDelayMs > now) return false;
      const state = deliveries.get(message.id);
      return !state || (!state.done && state.invisibleUntil <= now);
    });
  }

  private lease(key: string, message: StoredMessage, visibilitySeconds: number, now: number): { receipt: string; deliveryCount: number } {
    const deliveries = this.deliveriesOf(key);
    const state = deliveries.get(message.id) ?? { deliveryCount: 0, invisibleUntil: 0, done: false };
    state.deliveryCount += 1;
    state.invisibleUntil = now + visibilitySeconds * 1000;
    deliveries.set(message.id, state);
    const receipt = `rh_${randomUUID()}`;
    this.leases.set(receipt, { groupKey: key, messageId: message.id });
    return { receipt, deliveryCount: state.deliveryCount };
  }

  private receive(topic: string, group: string, headers: Record<string, string>, response: ServerResponse): void {
    const limit = headers["vqs-max-messages"] === undefined ? 1 : Number(headers["vqs-max-messages"]);
    const visibility = headers["vqs-visibility-timeout-seconds"] === undefined ? DEFAULT_VISIBILITY_SECONDS : Number(headers["vqs-visibility-timeout-seconds"]);
    if (!headers.accept?.includes("multipart/mixed")) {
      json(response, 400, { error: "Missing or unsupported Accept header" });
      return;
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 10 || !Number.isInteger(visibility) || visibility < 0 || visibility > 3_600) {
      json(response, 400, { error: "Invalid parameters" });
      return;
    }
    const now = Date.now();
    const key = this.groupKey(topic, group);
    const picked = this.ready(topic, key, now).slice(0, limit);
    if (picked.length === 0) {
      response.writeHead(204).end();
      return;
    }
    const boundary = `vqs-boundary-${randomUUID()}`;
    const chunks: Buffer[] = [];
    for (const message of picked) {
      const { receipt, deliveryCount } = this.lease(key, message, visibility, now);
      const head = [
        `Content-Type: ${message.contentType}`,
        `Vqs-Message-Id: ${message.id}`,
        `Vqs-Receipt-Handle: ${receipt}`,
        `Vqs-Delivery-Count: ${deliveryCount}`,
        `Vqs-Timestamp: ${new Date(message.createdAt).toISOString()}`,
        `Vqs-Expires-At: ${new Date(message.expiresAt).toISOString()}`,
      ].join("\r\n");
      chunks.push(Buffer.from(`--${boundary}\r\n${head}\r\n\r\n`), message.body, Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    response.writeHead(200, { "content-type": `multipart/mixed; boundary=${boundary}` });
    response.end(Buffer.concat(chunks));
  }

  private async dispatch(): Promise<void> {
    const now = Date.now();
    for (const trigger of this.triggers) {
      const key = this.groupKey(trigger.topic, trigger.consumerGroup);
      for (const message of this.ready(trigger.topic, key, now, (trigger.initialDelaySeconds ?? 0) * 1000)) {
        const flightKey = `${key}|${message.id}`;
        if (this.inFlightDispatch.has(flightKey)) continue;
        this.inFlightDispatch.add(flightKey);
        const { receipt, deliveryCount } = this.lease(key, message, DISPATCH_VISIBILITY_SECONDS, now);
        void this.deliver(trigger, key, message, receipt, deliveryCount).finally(() => this.inFlightDispatch.delete(flightKey));
      }
    }
  }

  private async deliver(trigger: FakeTrigger, key: string, message: StoredMessage, receipt: string, deliveryCount: number): Promise<void> {
    const visibilityDeadline = new Date(Date.now() + DISPATCH_VISIBILITY_SECONDS * 1000).toISOString();
    // Assumption: ce-id and ce-source are informational. The SDK never reads them in v2beta binary mode, so these formats are invented.
    const requestHeaders: Record<string, string> = {
      ...message.headers,
      "content-type": message.contentType,
      "ce-specversion": "1.0",
      "ce-id": message.id,
      "ce-source": `/queues/${message.topic}/consumer-groups/${trigger.consumerGroup}`,
      "ce-type": "com.vercel.queue.v2beta",
      "ce-vqsqueuename": message.topic,
      "ce-vqsconsumergroup": trigger.consumerGroup,
      "ce-vqsmessageid": message.id,
      "ce-vqsregion": "iad1",
      "ce-vqsreceipthandle": receipt,
      "ce-vqsdeliverycount": String(deliveryCount),
      "ce-vqscreatedat": new Date(message.createdAt).toISOString(),
      "ce-vqsexpiresat": new Date(message.expiresAt).toISOString(),
      "ce-vqsvisibilitydeadline": visibilityDeadline,
    };
    let status = 0;
    let responseBody = "";
    try {
      const response = await fetch(trigger.url, { method: "POST", headers: requestHeaders, body: new Uint8Array(message.body), redirect: "manual" });
      status = response.status;
      responseBody = await response.text();
    } catch (error) {
      responseBody = String(error);
    }
    this.dispatches.push({ messageId: message.id, deliveryCount, status, responseBody, requestHeaders });
    const delivery = this.deliveriesOf(key).get(message.id)!;
    if (status >= 200 && status < 300) return;
    if (this.leases.has(receipt)) {
      if (trigger.maxDeliveries !== undefined && deliveryCount >= trigger.maxDeliveries) {
        delivery.done = true;
        this.leases.delete(receipt);
        return;
      }
      // Assumption: a failed callback keeps the message invisible for the trigger's retryAfterSeconds (documented default 60) unless the SDK already moved the lease.
      delivery.invisibleUntil = Math.min(delivery.invisibleUntil, Date.now() + (trigger.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000);
    }
  }

  deliveriesOfMessage(messageId: string): number {
    let max = 0;
    for (const deliveries of this.groups.values()) max = Math.max(max, deliveries.get(messageId)?.deliveryCount ?? 0);
    return max;
  }

  isAcknowledged(pattern: string, group: string, messageId: string): boolean {
    return this.groups.get(this.groupKey(pattern, group))?.get(messageId)?.done ?? false;
  }
}
