export class MessageNotFoundError extends Error {
  constructor(messageId: string) {
    super(`Message ${messageId} not found`);
    this.name = "MessageNotFoundError";
  }
}

export class MessageNotAvailableError extends Error {
  constructor(messageId: string, reason?: string) {
    super(`Message ${messageId} not available for processing${reason ? `: ${reason}` : ""}`);
    this.name = "MessageNotAvailableError";
  }
}

export class MessageCorruptedError extends Error {
  constructor(messageId: string, reason: string) {
    super(`Message ${messageId} is corrupted: ${reason}`);
    this.name = "MessageCorruptedError";
  }
}

export class QueueEmptyError extends Error {
  constructor(queueName: string, consumerGroup: string) {
    super(`No messages available in queue "${queueName}" for consumer group "${consumerGroup}"`);
    this.name = "QueueEmptyError";
  }
}

export class MessageLockedError extends MessageNotAvailableError {
  readonly retryAfter?: number;
  constructor(messageId: string, retryAfter?: number) {
    super(messageId, retryAfter !== undefined ? `temporarily locked. Retry after ${retryAfter} seconds.` : "temporarily locked. Try again later.");
    this.name = "MessageLockedError";
    this.retryAfter = retryAfter;
  }
}

export class ConcurrencyCoalescedPendingError extends MessageNotAvailableError {
  readonly coalescedCount: number;
  constructor(messageId: string, coalescedCount: number) {
    super(messageId, `${coalescedCount} message(s) with its concurrency key were coalesced into this delivery`);
    this.name = "ConcurrencyCoalescedPendingError";
    this.coalescedCount = coalescedCount;
  }
}

export class TooManyRequestsError extends Error {
  readonly retryAfter?: number;
  constructor(message = "Too many requests", retryAfter?: number) {
    super(message);
    this.name = "TooManyRequestsError";
    this.retryAfter = retryAfter;
  }
}

export class UnauthorizedError extends Error {
  constructor(message = "Missing or invalid authentication token") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Queue environment doesn't match token environment") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

export class InternalServerError extends Error {
  constructor(message = "Unexpected server error") {
    super(message);
    this.name = "InternalServerError";
  }
}

export class InvalidLimitError extends Error {
  constructor(limit: number, min = 1, max = 10) {
    super(`Invalid limit: ${limit}. Limit must be between ${min} and ${max}.`);
    this.name = "InvalidLimitError";
  }
}

export class MessageAlreadyProcessedError extends Error {
  constructor(messageId: string) {
    super(`Message ${messageId} has already been processed`);
    this.name = "MessageAlreadyProcessedError";
  }
}

export class ConsumerDiscoveryError extends Error {
  readonly deploymentId?: string;
  constructor(message: string, deploymentId?: string) {
    super(message);
    this.name = "ConsumerDiscoveryError";
    this.deploymentId = deploymentId;
  }
}

export class ConsumerRegistryNotConfiguredError extends Error {
  constructor(message = "Consumer registry not configured") {
    super(message);
    this.name = "ConsumerRegistryNotConfiguredError";
  }
}
