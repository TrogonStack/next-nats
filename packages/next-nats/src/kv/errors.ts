import { Code, SpecError } from "../errors.js";

export class KvError extends SpecError {
  constructor(
    readonly code: string,
    message: string,
    spec: { code?: Code; reason?: string } = {},
  ) {
    super({
      code: code === "WRONGTYPE" ? Code.FAILED_PRECONDITION : Code.INVALID_ARGUMENT,
      reason: code === "WRONGTYPE" ? "WRONG_TYPE" : "INVALID_COMMAND",
      ...spec,
      domain: "next-nats.kv",
      message,
      legacyMessage: `${code} ${message}`,
    });
    this.name = "KvError";
  }
}

export class UpstashError extends KvError {
  constructor(code: string, message: string, spec: { code?: Code; reason?: string } = {}) {
    super(code, message, spec);
    this.name = "UpstashError";
  }
}
