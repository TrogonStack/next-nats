import { getNats } from "../connection.js";
import { BadRequestError, MessageAlreadyProcessedError, MessageNotAvailableError, UnauthorizedError } from "./errors.js";
import { ackLease, clampVisibility, decodeReceipt, processDelivery } from "./delivery.js";
import type { QueueStore } from "./store.js";
import { bufferToStream, type Transport } from "./transport.js";
import type {
  CallbackRequestInput,
  HandleCallbackOptions,
  Message,
  MessageHandler,
  NodeCallbackRequest,
  NodeCallbackResponse,
  ParsedCallbackRequest,
  ParsedCallbackV1,
  ParsedCallbackV2,
} from "./types.js";

export const CLOUD_EVENT_TYPE_V1BETA = "com.vercel.queue.v1beta";
export const CLOUD_EVENT_TYPE_V2BETA = "com.vercel.queue.v2beta";

const REGION = /^[a-z]{2,5}[0-9]{1,2}$/;

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getHeader(headers: HeaderBag, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function parseHandoffCount(value: string | null): number | undefined {
  if (!value) return undefined;
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : undefined;
}

function parseV1StructuredBody(body: unknown, contentType: string | null): ParsedCallbackV1 {
  if (!contentType || !contentType.includes("application/cloudevents+json")) {
    throw new Error("Invalid content type: expected 'application/cloudevents+json'");
  }
  if (!isRecord(body) || !body.type || !body.source || !body.id || !isRecord(body.data)) {
    throw new Error("Invalid CloudEvent: missing required fields");
  }
  if (body.type !== CLOUD_EVENT_TYPE_V1BETA) {
    throw new Error(`Invalid CloudEvent type: expected '${CLOUD_EVENT_TYPE_V1BETA}', got '${String(body.type)}'`);
  }
  const data = body.data;
  const missing = ["queueName", "consumerGroup", "messageId"].filter((field) => !(field in data));
  if (missing.length > 0) throw new Error(`Missing required CloudEvent data fields: ${missing.join(", ")}`);
  return {
    queueName: String(data.queueName),
    consumerGroup: String(data.consumerGroup),
    messageId: String(data.messageId),
  };
}

function parseBinaryHeaders(headers: HeaderBag): ParsedCallbackV1 | Omit<ParsedCallbackV2, "rawBody" | "parsedPayload"> {
  const ceType = getHeader(headers, "ce-type");
  if (ceType !== CLOUD_EVENT_TYPE_V2BETA) {
    throw new Error(`Invalid CloudEvent type: expected '${CLOUD_EVENT_TYPE_V2BETA}', got '${ceType}'`);
  }
  const queueName = getHeader(headers, "ce-vqsqueuename");
  const consumerGroup = getHeader(headers, "ce-vqsconsumergroup");
  const messageId = getHeader(headers, "ce-vqsmessageid");
  const missing: string[] = [];
  if (!queueName) missing.push("ce-vqsqueuename");
  if (!consumerGroup) missing.push("ce-vqsconsumergroup");
  if (!messageId) missing.push("ce-vqsmessageid");
  if (missing.length > 0) throw new Error(`Missing required CloudEvent headers: ${missing.join(", ")}`);
  const rawRegion = getHeader(headers, "ce-vqsregion") ?? undefined;
  if (rawRegion !== undefined && !REGION.test(rawRegion)) {
    throw new Error(`Invalid ce-vqsregion header: ${JSON.stringify(rawRegion)}. Region must match /^[a-z]{2,5}[0-9]{1,2}$/ (e.g. "iad1", "lhr1").`);
  }
  const base: ParsedCallbackV1 = { queueName: queueName!, consumerGroup: consumerGroup!, messageId: messageId!, region: rawRegion };
  const receiptHandle = getHeader(headers, "ce-vqsreceipthandle");
  if (!receiptHandle) return base;
  const result: Omit<ParsedCallbackV2, "rawBody" | "parsedPayload"> = { ...base, receiptHandle };
  const deliveryCount = getHeader(headers, "ce-vqsdeliverycount");
  if (deliveryCount) result.deliveryCount = parseInt(deliveryCount, 10);
  const createdAt = getHeader(headers, "ce-vqscreatedat");
  if (createdAt) result.createdAt = createdAt;
  const expiresAt = getHeader(headers, "ce-vqsexpiresat");
  if (expiresAt) result.expiresAt = expiresAt;
  const contentType = getHeader(headers, "content-type");
  if (contentType) result.contentType = contentType;
  const visibilityDeadline = getHeader(headers, "ce-vqsvisibilitydeadline");
  if (visibilityDeadline) result.visibilityDeadline = visibilityDeadline;
  const handoff = parseHandoffCount(getHeader(headers, "ce-vqsexperimentalhandoffcount"));
  if (handoff !== undefined) result.experimental_handoffCount = handoff;
  return result;
}

export function parseRawCallback(body: unknown, headers: Record<string, string | string[] | undefined>): ParsedCallbackRequest {
  if (getHeader(headers, "ce-type") === CLOUD_EVENT_TYPE_V2BETA) {
    const result = parseBinaryHeaders(headers);
    if ("receiptHandle" in result) (result as ParsedCallbackV2).parsedPayload = body;
    return result;
  }
  return parseV1StructuredBody(body, getHeader(headers, "content-type"));
}

export async function parseCallback(request: Request): Promise<ParsedCallbackRequest> {
  if (request.headers.get("ce-type") === CLOUD_EVENT_TYPE_V2BETA) {
    const result = parseBinaryHeaders(request.headers);
    if ("receiptHandle" in result && request.body) (result as ParsedCallbackV2).rawBody = request.body;
    return result;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new Error("Failed to parse CloudEvent from request body");
  }
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return parseRawCallback(body, headers);
}

export interface CallbackContext {
  store: QueueStore;
  transport: Transport;
  region: string;
}

export async function consumeCallback<T>(handler: MessageHandler<T>, request: ParsedCallbackRequest, options: HandleCallbackOptions, ctx: CallbackContext): Promise<void> {
  if (!("receiptHandle" in request)) {
    throw new BadRequestError("Binary mode callback: receipt handle required, callbacks without one are not supported on NATS");
  }
  let payload: T;
  if (request.rawBody) payload = (await ctx.transport.deserialize(request.rawBody)) as T;
  else if (request.parsedPayload !== undefined) payload = request.parsedPayload as T;
  else throw new BadRequestError("Binary mode callback with receipt handle is missing payload");

  const reply = decodeReceipt(request.receiptHandle, ctx.store);
  const { nc } = await getNats();
  const message: Message<T> = {
    messageId: request.messageId,
    payload,
    deliveryCount: request.deliveryCount ?? 1,
    createdAt: request.createdAt ? new Date(request.createdAt) : new Date(),
    expiresAt: request.expiresAt ? new Date(request.expiresAt) : undefined,
    contentType: request.contentType ?? ctx.transport.contentType,
    receiptHandle: request.receiptHandle,
    ...(request.experimental_handoffCount !== undefined && { experimental_handoffCount: request.experimental_handoffCount }),
  };
  await processDelivery(handler, {
    topicName: request.queueName,
    consumerGroup: request.consumerGroup,
    region: request.region ?? ctx.region,
    message,
    lease: ackLease(nc, reply),
    visibilityTimeoutSeconds: clampVisibility(options.visibilityTimeoutSeconds),
    visibilityDeadline: request.visibilityDeadline ? new Date(request.visibilityDeadline) : undefined,
    retry: options.retry,
    transport: ctx.transport,
  });
}

const PARSE_ERRORS = ["Invalid content type", "Invalid CloudEvent", "Missing required CloudEvent", "Failed to parse CloudEvent", "Binary mode callback"];

function skippedReason(error: unknown): "already_processed" | "not_available" | null {
  if (error instanceof MessageAlreadyProcessedError || (error instanceof Error && error.name === "MessageAlreadyProcessedError")) return "already_processed";
  if (error instanceof MessageNotAvailableError || (error instanceof Error && error.name === "MessageNotAvailableError")) return "not_available";
  return null;
}

type Outcome = { status: number; body: unknown };

async function outcomeOf(run: () => Promise<ParsedCallbackRequest | undefined>, parsedOf: () => ParsedCallbackRequest | undefined): Promise<Outcome> {
  try {
    await run();
    return { status: 200, body: { status: "success" } };
  } catch (error) {
    const skipped = skippedReason(error);
    if (skipped) {
      const messageId = parsedOf()?.messageId;
      return { status: 200, body: { status: "skipped", reason: skipped, ...(messageId !== undefined && { messageId }) } };
    }
    if (error instanceof UnauthorizedError) return { status: 401, body: { error: error.message } };
    console.error("Queue callback error:", error);
    if (error instanceof BadRequestError || (error instanceof Error && PARSE_ERRORS.some((fragment) => error.message.includes(fragment)))) {
      return { status: 400, body: { error: (error as Error).message } };
    }
    return { status: 500, body: { error: "Failed to process queue message" } };
  }
}

export function webCallback<T>(handler: MessageHandler<T>, options: HandleCallbackOptions | undefined, ctx: () => CallbackContext) {
  return async (requestOrEvent: CallbackRequestInput): Promise<Response> => {
    const request = "request" in requestOrEvent ? requestOrEvent.request : requestOrEvent;
    let parsed: ParsedCallbackRequest | undefined;
    const outcome = await outcomeOf(
      async () => {
        parsed = await parseCallback(request);
        await consumeCallback(handler, parsed, options ?? {}, ctx());
        return parsed;
      },
      () => parsed,
    );
    return Response.json(outcome.body, { status: outcome.status });
  };
}

export function nodeCallback<T>(handler: MessageHandler<T>, options: HandleCallbackOptions | undefined, ctx: () => CallbackContext) {
  return async (req: NodeCallbackRequest, res: NodeCallbackResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.status(200).end();
      return;
    }
    let parsed: ParsedCallbackRequest | undefined;
    const outcome = await outcomeOf(
      async () => {
        parsed = parseRawCallback(req.body, req.headers);
        if ("receiptHandle" in parsed && parsed.parsedPayload !== undefined && Buffer.isBuffer(parsed.parsedPayload)) {
          parsed.rawBody = bufferToStream(parsed.parsedPayload);
        }
        await consumeCallback(handler, parsed, options ?? {}, ctx());
        return parsed;
      },
      () => parsed,
    );
    res.status(outcome.status).json(outcome.body);
  };
}
