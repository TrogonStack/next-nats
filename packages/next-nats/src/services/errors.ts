import { Code, codeOfHttpStatus, SpecError, Visibility } from "../errors.js";

const DOMAIN = "next-nats.services";

export class EndpointError extends SpecError {
  readonly code: number;

  constructor(code: number, message: string, options?: ErrorOptions & { reason?: string }) {
    super({
      code: codeOfHttpStatus(code),
      domain: DOMAIN,
      reason: options?.reason ?? "ENDPOINT_FAILED",
      message,
      visibility: Visibility.PUBLIC,
      cause: options?.cause,
    });
    this.name = "EndpointError";
    this.code = code;
  }
}

export type ServiceCallFailure = "service" | "timeout" | "unavailable";

const CALL_FAILURE = {
  service: { reason: "SERVICE_ERROR" },
  timeout: { code: Code.DEADLINE_EXCEEDED, reason: "TIMEOUT" },
  unavailable: { code: Code.UNAVAILABLE, reason: "NO_RESPONDERS" },
} as const;

export class ServiceCallError extends SpecError {
  readonly code: number;
  readonly kind: ServiceCallFailure;
  readonly service: string;
  readonly endpoint: string;
  readonly subject: string;

  constructor(
    init: { code: number; kind: ServiceCallFailure; message: string; service: string; endpoint: string; subject: string },
    options?: ErrorOptions,
  ) {
    const failure = CALL_FAILURE[init.kind];
    super({
      code: "code" in failure ? failure.code : codeOfHttpStatus(init.code),
      domain: DOMAIN,
      reason: failure.reason,
      message: init.message,
      visibility: init.kind === "service" && init.code < 500 ? Visibility.PUBLIC : Visibility.PRIVATE,
      metadata: {
        service: { value: init.service, visibility: Visibility.PRIVATE },
        endpoint: { value: init.endpoint, visibility: Visibility.PRIVATE },
        subject: { value: init.subject, visibility: Visibility.INTERNAL },
      },
      cause: options?.cause,
    });
    this.name = "ServiceCallError";
    this.code = init.code;
    this.kind = init.kind;
    this.service = init.service;
    this.endpoint = init.endpoint;
    this.subject = init.subject;
  }
}
