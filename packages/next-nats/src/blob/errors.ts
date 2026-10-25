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

export class BlobNotFoundError extends BlobError {
  constructor() {
    super("The requested blob does not exist", { code: Code.NOT_FOUND, reason: "BLOB_NOT_FOUND" });
  }
}

export class BlobAccessError extends BlobError {
  constructor() {
    super("Access denied, please provide a valid token for this resource", {
      code: Code.PERMISSION_DENIED,
      reason: "BLOB_ACCESS_DENIED",
    });
  }
}

export class BlobPreconditionFailedError extends BlobError {
  constructor() {
    super("Precondition failed: ETag mismatch.", { code: Code.FAILED_PRECONDITION, reason: "ETAG_MISMATCH" });
  }
}

export class BlobFileTooLargeError extends BlobError {
  constructor(message: string) {
    super(message, { code: Code.OUT_OF_RANGE, reason: "BLOB_TOO_LARGE" });
  }
}

export class BlobContentTypeNotAllowedError extends BlobError {
  constructor(message: string) {
    super(message, { code: Code.INVALID_ARGUMENT, reason: "CONTENT_TYPE_NOT_ALLOWED" });
  }
}

export class BlobClientTokenExpiredError extends BlobError {
  constructor() {
    super("Client token has expired", { code: Code.UNAUTHENTICATED, reason: "CLIENT_TOKEN_EXPIRED" });
  }
}

export class BlobPathnameMismatchError extends BlobError {
  constructor(message: string) {
    super(message, { code: Code.PERMISSION_DENIED, reason: "PATHNAME_MISMATCH" });
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
