export class BlobError extends Error {
  constructor(message: string) {
    super(`Vercel Blob: ${message}`);
    this.name = new.target.name;
  }
}

export class BlobNotFoundError extends BlobError {
  constructor() {
    super("The requested blob does not exist");
  }
}

export class BlobAccessError extends BlobError {
  constructor() {
    super("Access denied, please provide a valid token for this resource");
  }
}

export class BlobPreconditionFailedError extends BlobError {
  constructor() {
    super("Precondition failed: ETag mismatch.");
  }
}

export class BlobFileTooLargeError extends BlobError {
  constructor(message: string) {
    super(message);
  }
}

export class BlobContentTypeNotAllowedError extends BlobError {
  constructor(message: string) {
    super(message);
  }
}

export class BlobClientTokenExpiredError extends BlobError {
  constructor() {
    super("Client token has expired");
  }
}

export class BlobPathnameMismatchError extends BlobError {
  constructor(message: string) {
    super(message);
  }
}
