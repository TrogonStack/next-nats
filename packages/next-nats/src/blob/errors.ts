import { Code, SpecError, Visibility, type SpecErrorInit } from "../errors.js";

const DOMAIN = "next-nats.blob";

export class BlobError extends SpecError {
  constructor(
    message: string,
    spec: Partial<Pick<SpecErrorInit, "code" | "reason" | "visibility" | "subject">> = {},
  ) {
    super({
      code: Code.INVALID_ARGUMENT,
      reason: "INVALID_BLOB",
      visibility: Visibility.PUBLIC,
      ...spec,
      domain: DOMAIN,
      message,
      legacyMessage: `Vercel Blob: ${message}`,
    });
  }
}

export class BlobAccessError extends BlobError {
  constructor() {
    super("Access denied, please provide a valid token for this resource.", {
      code: Code.PERMISSION_DENIED,
      reason: "BLOB_ACCESS_DENIED",
    });
  }
}

export class BlobContentTypeNotAllowedError extends BlobError {
  constructor(message: string) {
    super(`Content type mismatch, ${message}.`, { code: Code.INVALID_ARGUMENT, reason: "CONTENT_TYPE_NOT_ALLOWED" });
  }
}

export class BlobPathnameMismatchError extends BlobError {
  constructor(message: string) {
    super(
      `Pathname mismatch, ${message}. Check the pathname used in upload() or put() matches the one from the client token.`,
      { code: Code.PERMISSION_DENIED, reason: "PATHNAME_MISMATCH" },
    );
  }
}

export class BlobClientTokenExpiredError extends BlobError {
  constructor() {
    super("Client token has expired.", { code: Code.UNAUTHENTICATED, reason: "CLIENT_TOKEN_EXPIRED" });
  }
}

export class BlobFileTooLargeError extends BlobError {
  constructor(message: string) {
    super(`File is too large, ${message}.`, { code: Code.OUT_OF_RANGE, reason: "BLOB_TOO_LARGE" });
  }
}

export class BlobStoreNotFoundError extends BlobError {
  constructor() {
    super("This store does not exist.", { code: Code.NOT_FOUND, reason: "BLOB_STORE_NOT_FOUND" });
  }
}

export class BlobStoreSuspendedError extends BlobError {
  constructor() {
    super("This store has been suspended.", { code: Code.PERMISSION_DENIED, reason: "BLOB_STORE_SUSPENDED" });
  }
}

export class BlobUnknownError extends BlobError {
  constructor() {
    super("Unknown error, please visit https://vercel.com/help.", { code: Code.UNKNOWN, reason: "BLOB_UNKNOWN" });
  }
}

export class BlobNotFoundError extends BlobError {
  constructor() {
    super("The requested blob does not exist", { code: Code.NOT_FOUND, reason: "BLOB_NOT_FOUND" });
  }
}

export class BlobServiceNotAvailable extends BlobError {
  constructor() {
    super("The blob service is currently not available. Please try again.", {
      code: Code.UNAVAILABLE,
      reason: "BLOB_SERVICE_NOT_AVAILABLE",
    });
  }
}

export class BlobServiceRateLimited extends BlobError {
  readonly retryAfter: number;

  constructor(seconds?: number) {
    super(
      `Too many requests please lower the number of concurrent requests ${seconds ? ` - try again in ${seconds} seconds` : ""}.`,
      { code: Code.RESOURCE_EXHAUSTED, reason: "BLOB_RATE_LIMITED" },
    );
    this.retryAfter = seconds ?? 0;
  }
}

export class BlobRequestAbortedError extends BlobError {
  constructor() {
    super("The request was aborted.", { code: Code.CANCELLED, reason: "BLOB_REQUEST_ABORTED" });
  }
}

export class BlobPreconditionFailedError extends BlobError {
  constructor() {
    super("Precondition failed: ETag mismatch.", { code: Code.FAILED_PRECONDITION, reason: "ETAG_MISMATCH" });
  }
}

export class BlobAlreadyExistsError extends BlobError {
  constructor() {
    super("This blob already exists, use `allowOverwrite: true` to overwrite it", {
      code: Code.ALREADY_EXISTS,
      reason: "BLOB_ALREADY_EXISTS",
    });
  }
}

const BY_REASON: Record<string, (message: string) => BlobError> = {
  BLOB_ACCESS_DENIED: () => new BlobAccessError(),
  BLOB_NOT_FOUND: () => new BlobNotFoundError(),
  CLIENT_TOKEN_EXPIRED: () => new BlobClientTokenExpiredError(),
  ETAG_MISMATCH: () => new BlobPreconditionFailedError(),
  BLOB_ALREADY_EXISTS: () => new BlobAlreadyExistsError(),
  BLOB_STORE_NOT_FOUND: () => new BlobStoreNotFoundError(),
  BLOB_STORE_SUSPENDED: () => new BlobStoreSuspendedError(),
  BLOB_SERVICE_NOT_AVAILABLE: () => new BlobServiceNotAvailable(),
  BLOB_RATE_LIMITED: () => new BlobServiceRateLimited(),
  BLOB_UNKNOWN: () => new BlobUnknownError(),
  BLOB_REQUEST_ABORTED: () => new BlobRequestAbortedError(),
  BLOB_TOO_LARGE: (message) => new BlobFileTooLargeError(message.replace(/^File is too large, /, "").replace(/\.$/, "")),
  CONTENT_TYPE_NOT_ALLOWED: (message) =>
    new BlobContentTypeNotAllowedError(message.replace(/^Content type mismatch, /, "").replace(/\.$/, "")),
  PATHNAME_MISMATCH: (message) =>
    new BlobPathnameMismatchError(message.replace(/^Pathname mismatch, /, "").replace(/\. Check the pathname.*$/, "")),
};

export async function blobErrorFromResponse(response: Response): Promise<BlobError> {
  const body = (await response.json().catch(() => null)) as { message?: string; reason?: string } | null;
  const message = body?.message ?? `${response.status} ${response.statusText}`.trim();
  const build = body?.reason ? BY_REASON[body.reason] : undefined;
  if (build) return build(message);
  if (response.status === 429) return new BlobServiceRateLimited(Number(response.headers.get("retry-after")) || undefined);
  if (response.status === 503) return new BlobServiceNotAvailable();
  return new BlobError(message, body?.reason ? { reason: body.reason } : {});
}
