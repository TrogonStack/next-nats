import { Code, SpecError, Visibility } from "../errors.js";

const DOMAIN = "next-nats.edge";

export type RequestFailure = "timeout" | "unavailable" | "service";

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
