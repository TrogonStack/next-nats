import { RequestError, TimeoutError, type MsgHdrs } from "@nats-io/nats-core";
import { codec } from "../codec.js";
import { buildHeaders, type PayloadOf, type SubjectName, type TraceOptions } from "../publish-core.js";
import { getEdgeNats } from "./connection.js";
import { EdgeRequestError } from "./request-error.js";

const SERVICE_ERROR_HEADER = "Nats-Service-Error";
const SERVICE_ERROR_CODE_HEADER = "Nats-Service-Error-Code";

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
