export class EndpointError extends Error {
  readonly code: number;

  constructor(code: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EndpointError";
    this.code = code;
  }
}

export type ServiceCallFailure = "service" | "timeout" | "unavailable";

export class ServiceCallError extends Error {
  readonly code: number;
  readonly kind: ServiceCallFailure;
  readonly service: string;
  readonly endpoint: string;
  readonly subject: string;

  constructor(
    init: { code: number; kind: ServiceCallFailure; message: string; service: string; endpoint: string; subject: string },
    options?: ErrorOptions,
  ) {
    super(init.message, options);
    this.name = "ServiceCallError";
    this.code = init.code;
    this.kind = init.kind;
    this.service = init.service;
    this.endpoint = init.endpoint;
    this.subject = init.subject;
  }
}
