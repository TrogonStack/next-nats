import { RequestError, TimeoutError, type MsgHdrs } from "@nats-io/nats-core";
import { codec } from "../codec.js";
import { Code, SpecError, Visibility } from "../errors.js";
import { buildHeaders, type PayloadOf, type SubjectName, type TraceOptions } from "../publish-core.js";
import { getEdgeNats } from "./connection.js";

const DOMAIN = "next-nats.edge";
const SERVICE_ERROR_HEADER = "Nats-Service-Error";
const SERVICE_ERROR_CODE_HEADER = "Nats-Service-Error-Code";

export type RequestFailure = "timeout" | "unavailable" | "service";

export interface EdgeRequestOptions extends TraceOptions {
  timeout?: number;
  headers?: Record<string, string>;
}

export interface EdgeReply {
  readonly subject: string;
  readonly data: Uint8Array;
  readonly headers?: MsgHdrs;
  json<T = unknown>(): T;
  string(): string;
}

export class EdgeRequestError extends SpecError {
  readonly kind: RequestFailure;
  readonly status: number;
  readonly subject: string;

  constructor(init: { kind: RequestFailure; status: number; subject: string; message: string }, options?: ErrorOptions) {
    super({
      code: init.kind === "timeout" ? Code.DEADLINE_EXCEEDED : init.kind === "unavailable" ? Code.UNAVAILABLE : codeOfStatus(init.status),
      domain: DOMAIN,
      reason: init.kind === "timeout" ? "REQUEST_TIMEOUT" : init.kind === "unavailable" ? "NO_RESPONDERS" : "SERVICE_ERROR",
      message: init.message,
      visibility: init.kind === "service" && init.status < 500 ? Visibility.PUBLIC : Visibility.PRIVATE,
      cause: options?.cause,
    });
    this.name = "EdgeRequestError";
    this.kind = init.kind;
    this.status = init.status;
    this.subject = init.subject;
  }
}

function codeOfStatus(status: number): Code {
  if (status === 404) return Code.NOT_FOUND;
  if (status === 401) return Code.UNAUTHENTICATED;
  if (status === 403) return Code.PERMISSION_DENIED;
  return status >= 500 ? Code.INTERNAL : Code.INVALID_ARGUMENT;
}

export async function edgeRequest<S extends SubjectName>(
  subject: S,
  payload?: PayloadOf<S>,
  opts: EdgeRequestOptions = {},
): Promise<EdgeReply> {
  const { nc } = await getEdgeNats();
  let reply;
  try {
    reply = await nc.request(subject, payload === undefined ? undefined : codec.encode(payload), {
      timeout: opts.timeout ?? 5_000,
      headers: buildHeaders(opts),
    });
  } catch (error) {
    if (error instanceof RequestError && error.isNoResponders()) {
      throw new EdgeRequestError({ kind: "unavailable", status: 503, subject, message: `No responders for ${subject}` }, { cause: error });
    }
    if (error instanceof TimeoutError || (error instanceof RequestError && error.cause instanceof TimeoutError)) {
      throw new EdgeRequestError({ kind: "timeout", status: 408, subject, message: `Request to ${subject} timed out` }, { cause: error });
    }
    throw error;
  }
  const failure = reply.headers?.get(SERVICE_ERROR_CODE_HEADER);
  if (failure) {
    const status = parseInt(failure, 10) || 400;
    throw new EdgeRequestError({ kind: "service", status, subject, message: reply.headers?.get(SERVICE_ERROR_HEADER) || failure });
  }
  return {
    subject: reply.subject,
    data: reply.data,
    headers: reply.headers,
    json: <T>() => codec.decodeJson(reply.data) as T,
    string: () => codec.decodeText(reply.data),
  };
}
