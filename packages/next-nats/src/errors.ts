export const Code = {
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;
export type CodeName = keyof typeof Code;
export type Code = (typeof Code)[CodeName];

export const Visibility = {
  INTERNAL: 0,
  PRIVATE: 1,
  PUBLIC: 2,
} as const;
export type VisibilityName = keyof typeof Visibility;
export type Visibility = (typeof Visibility)[VisibilityName];

export const SPEC_VERSION = 1;

const HTTP_STATUS: Record<CodeName, number> = {
  CANCELLED: 499,
  UNKNOWN: 500,
  INVALID_ARGUMENT: 400,
  DEADLINE_EXCEEDED: 504,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  PERMISSION_DENIED: 403,
  RESOURCE_EXHAUSTED: 429,
  FAILED_PRECONDITION: 400,
  ABORTED: 409,
  OUT_OF_RANGE: 400,
  UNIMPLEMENTED: 501,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  DATA_LOSS: 500,
  UNAUTHENTICATED: 401,
};

const CODE_NAMES = Object.fromEntries(Object.entries(Code).map(([name, value]) => [value, name])) as Record<Code, CodeName>;

export function codeName(code: Code): CodeName {
  return CODE_NAMES[code];
}

export function httpStatusOf(code: Code): number {
  return HTTP_STATUS[codeName(code)];
}

export function codeOfHttpStatus(status: number): Code {
  if (status === 408 || status === 504) return Code.DEADLINE_EXCEEDED;
  if (status === 401) return Code.UNAUTHENTICATED;
  if (status === 403) return Code.PERMISSION_DENIED;
  if (status === 404) return Code.NOT_FOUND;
  if (status === 409) return Code.ABORTED;
  if (status === 429) return Code.RESOURCE_EXHAUSTED;
  if (status === 499) return Code.CANCELLED;
  if (status === 501) return Code.UNIMPLEMENTED;
  if (status === 503) return Code.UNAVAILABLE;
  if (status >= 400 && status < 500) return Code.INVALID_ARGUMENT;
  return Code.INTERNAL;
}

export interface MetadataEntry {
  readonly value: string;
  readonly visibility: Visibility;
}

export type Metadata = Readonly<Record<string, MetadataEntry>>;

export interface ErrorSpec {
  readonly specversion: number;
  readonly code: Code;
  readonly message: string;
  readonly domain: string;
  readonly reason: string;
  readonly metadata: Metadata;
  readonly causes: readonly ErrorSpec[];
  readonly visibility: Visibility;
  readonly subject?: string;
  readonly id: string;
  readonly time: string;
}

export interface PublicErrorBody {
  readonly code: CodeName;
  readonly message: string;
  readonly id: string;
  readonly domain?: string;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, { readonly value: string }>>;
  readonly causes?: readonly PublicErrorBody[];
  readonly subject?: string;
}

export const GENERIC_MESSAGE = "An internal error occurred";

export interface SpecErrorInit {
  code: Code;
  domain: string;
  reason: string;
  message: string;
  visibility?: Visibility;
  metadata?: Metadata;
  causes?: readonly ErrorSpec[];
  subject?: string;
  legacyMessage?: string;
  cause?: unknown;
}

export class SpecError extends Error {
  readonly spec: ErrorSpec;

  constructor(init: SpecErrorInit) {
    super(init.legacyMessage ?? init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.spec = {
      specversion: SPEC_VERSION,
      code: init.code,
      message: init.message,
      domain: init.domain,
      reason: init.reason,
      metadata: init.metadata ?? {},
      causes: init.causes ?? [],
      visibility: init.visibility ?? Visibility.PRIVATE,
      ...(init.subject !== undefined && { subject: init.subject }),
      id: globalThis.crypto.randomUUID(),
      time: new Date().toISOString(),
    };
  }

  toPublic(boundary: Visibility = Visibility.PUBLIC): PublicErrorBody {
    return filterSpec(this.spec, boundary);
  }
}

export class InvalidArgumentError extends SpecError {
  constructor(init: Omit<SpecErrorInit, "code">) {
    super({ ...init, code: Code.INVALID_ARGUMENT });
  }
}

export class FailedPreconditionError extends SpecError {
  constructor(init: Omit<SpecErrorInit, "code">) {
    super({ visibility: Visibility.INTERNAL, ...init, code: Code.FAILED_PRECONDITION });
  }
}

export function invalidArgument(domain: string, reason: string, message: string): InvalidArgumentError {
  return new InvalidArgumentError({ domain, reason, message });
}

export function failedPrecondition(domain: string, reason: string, message: string): FailedPreconditionError {
  return new FailedPreconditionError({ domain, reason, message });
}

function genericBody(id: string): PublicErrorBody {
  return { code: "INTERNAL", message: GENERIC_MESSAGE, id };
}

export function filterSpec(spec: ErrorSpec, boundary: Visibility = Visibility.PUBLIC): PublicErrorBody {
  if (spec.visibility < boundary) return genericBody(spec.id);
  const metadata = Object.fromEntries(
    Object.entries(spec.metadata)
      .filter(([, entry]) => entry.visibility >= boundary)
      .map(([key, entry]) => [key, { value: entry.value }]),
  );
  const causes = spec.causes.filter((cause) => cause.visibility >= boundary).map((cause) => filterSpec(cause, boundary));
  return {
    code: codeName(spec.code),
    message: spec.message,
    id: spec.id,
    domain: spec.domain,
    reason: spec.reason,
    ...(Object.keys(metadata).length > 0 && { metadata }),
    ...(causes.length > 0 && { causes }),
    ...(spec.subject !== undefined && { subject: spec.subject }),
  };
}

export function toSpecError(error: unknown): SpecError {
  if (error instanceof SpecError) return error;
  return new SpecError({
    code: Code.INTERNAL,
    domain: "next-nats",
    reason: "UNHANDLED",
    message: GENERIC_MESSAGE,
    visibility: Visibility.INTERNAL,
    cause: error,
  });
}

export function toPublicError(error: unknown, boundary: Visibility = Visibility.PUBLIC): PublicErrorBody {
  return toSpecError(error).toPublic(boundary);
}

export function publicErrorResponse(error: unknown, init?: ResponseInit): Response {
  const spec = toSpecError(error);
  return Response.json(spec.toPublic(), { ...init, status: init?.status ?? httpStatusOf(spec.spec.code) });
}
