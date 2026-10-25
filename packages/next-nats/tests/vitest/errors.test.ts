import { describe, expect, it, vi } from "vitest";
import { BlobNotFoundError, BlobError } from "../../src/blob/errors.js";
import { resolveConfig } from "../../src/config.js";
import { EdgeConfigError } from "../../src/edge-config/index.js";
import {
  Code,
  codeName,
  filterSpec,
  httpStatusOf,
  SpecError,
  toPublicError,
  toSpecError,
  Visibility,
} from "../../src/errors.js";
import { KvError } from "../../src/kv/store.js";
import { consoleLogger, getLogger, LogLevel, setLogger, warnThrottled, type Logger } from "../../src/logger.js";
import { EndpointError, ServiceCallError } from "../../src/services/errors.js";
import { ValidationError } from "../../src/services/schema.js";
import { subject } from "../../src/values.js";

describe("Code and Visibility", () => {
  it("keeps the spec integer values and UPPERCASE names", () => {
    expect(Code.INVALID_ARGUMENT).toBe(3);
    expect(Code.NOT_FOUND).toBe(5);
    expect(Code.INTERNAL).toBe(13);
    expect(Code.UNAUTHENTICATED).toBe(16);
    expect(Visibility).toEqual({ INTERNAL: 0, PRIVATE: 1, PUBLIC: 2 });
    expect(codeName(Code.RESOURCE_EXHAUSTED)).toBe("RESOURCE_EXHAUSTED");
    expect(httpStatusOf(Code.RESOURCE_EXHAUSTED)).toBe(429);
  });
});

describe("SpecError", () => {
  const error = new SpecError({
    code: Code.NOT_FOUND,
    domain: "next-nats.test",
    reason: "MISSING",
    message: "missing",
    visibility: Visibility.PUBLIC,
    metadata: {
      shown: { value: "a", visibility: Visibility.PUBLIC },
      org: { value: "b", visibility: Visibility.PRIVATE },
      secret: { value: "c", visibility: Visibility.INTERNAL },
    },
  });

  it("carries the spec shape", () => {
    expect(error).toBeInstanceOf(Error);
    expect(error.spec).toMatchObject({
      specversion: 1,
      code: Code.NOT_FOUND,
      message: "missing",
      domain: "next-nats.test",
      reason: "MISSING",
      causes: [],
      visibility: Visibility.PUBLIC,
    });
    expect(error.spec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(error.spec.time))).toBe(false);
  });

  it("filters metadata by boundary", () => {
    expect(Object.keys(error.toPublic().metadata ?? {})).toEqual(["shown"]);
    expect(Object.keys(error.toPublic(Visibility.PRIVATE).metadata ?? {})).toEqual(["shown", "org"]);
    expect(Object.keys(error.toPublic(Visibility.INTERNAL).metadata ?? {})).toEqual(["shown", "org", "secret"]);
  });

  it("drops errors below the boundary and returns the generic error", () => {
    const hidden = new SpecError({
      code: Code.UNAVAILABLE,
      domain: "x",
      reason: "DB_DOWN",
      message: "postgres://user:pw@10.0.0.1 refused",
      visibility: Visibility.INTERNAL,
    });
    expect(hidden.toPublic(Visibility.PRIVATE)).toEqual({ code: "INTERNAL", message: "An internal error occurred", id: hidden.spec.id });
    expect(filterSpec(hidden.spec)).not.toHaveProperty("reason");
  });

  it("wraps unknown errors as INTERNAL and never exposes their message", () => {
    const wrapped = toSpecError(new Error("secret detail"));
    expect(wrapped.spec).toMatchObject({ code: Code.INTERNAL, visibility: Visibility.INTERNAL });
    expect(wrapped.cause).toBeInstanceOf(Error);
    expect(JSON.stringify(toPublicError(new Error("secret detail")))).not.toContain("secret");
  });
});

describe("migrated errors keep their compat surface", () => {
  it("blob", () => {
    const missing = new BlobNotFoundError();
    expect(missing).toBeInstanceOf(BlobError);
    expect(missing.name).toBe("BlobNotFoundError");
    expect(missing.message).toBe("Vercel Blob: The requested blob does not exist");
    expect(missing.spec).toMatchObject({ code: Code.NOT_FOUND, domain: "next-nats.blob", reason: "BLOB_NOT_FOUND" });
    expect(missing.toPublic().message).toBe("The requested blob does not exist");
  });

  it("kv", () => {
    const wrong = new KvError("WRONGTYPE", "Operation against a key holding the wrong kind of value");
    expect(wrong.name).toBe("KvError");
    expect(wrong.code).toBe("WRONGTYPE");
    expect(wrong.message).toMatch(/^WRONGTYPE /);
    expect(wrong.spec).toMatchObject({ code: Code.FAILED_PRECONDITION, reason: "WRONG_TYPE" });
  });

  it("edge config", () => {
    const error = new EdgeConfigError("nope", { code: Code.NOT_FOUND, reason: "ITEM_NOT_FOUND" });
    expect(error.name).toBe("EdgeConfigError");
    expect(error.spec).toMatchObject({ code: Code.NOT_FOUND, domain: "next-nats.edge-config" });
  });

  it("services", () => {
    const endpoint = new EndpointError(422, "Division by zero");
    expect(endpoint.code).toBe(422);
    expect(endpoint.spec.visibility).toBe(Visibility.PUBLIC);
    const call = new ServiceCallError({ code: 408, kind: "timeout", message: "t", service: "s", endpoint: "e", subject: "s.e" });
    expect(call).toMatchObject({ code: 408, kind: "timeout", service: "s", endpoint: "e", subject: "s.e" });
    expect(call.spec.code).toBe(Code.DEADLINE_EXCEEDED);
    expect(call.toPublic().message).toBe("An internal error occurred");
    const validation = new ValidationError([{ message: "bad", path: ["a", { key: "b/c" }] }]);
    expect(validation.spec.causes[0]).toMatchObject({ subject: "/a/b~1c", reason: "INVALID_FIELD" });
    expect(validation.toPublic().causes?.[0]?.subject).toBe("/a/b~1c");
  });

  it("validation helpers throw spec errors", () => {
    expect.assertions(4);
    try {
      subject("a..b");
    } catch (error) {
      expect(error).toBeInstanceOf(SpecError);
      expect((error as SpecError).spec).toMatchObject({ code: Code.INVALID_ARGUMENT, reason: "INVALID_SUBJECT" });
    }
    try {
      resolveConfig({}, { NATS_TRANSPORT: "udp" });
    } catch (error) {
      expect((error as SpecError).spec).toMatchObject({ domain: "next-nats.config", reason: "INVALID_TRANSPORT" });
      expect((error as SpecError).toPublic().message).toBe("An internal error occurred");
    }
  });
});

describe("logger", () => {
  it("lets callers inject their own logger", () => {
    const calls: string[] = [];
    const custom: Logger = {
      debug: (m) => void calls.push(`debug:${m}`),
      info: (m) => void calls.push(`info:${m}`),
      warning: (m) => void calls.push(`warning:${m}`),
      error: (m) => void calls.push(`error:${m}`),
    };
    setLogger(custom);
    try {
      getLogger().error("boom");
      expect(calls).toEqual(["error:boom"]);
    } finally {
      setLogger(consoleLogger());
    }
  });

  it("filters below the minimum level and routes levels to the matching console method", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const logger = consoleLogger(LogLevel.WARNING);
      logger.info("quiet");
      logger.warning("loud", { key: 1 });
      expect(info).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("[next-nats] loud", { key: 1 });
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it("throttles repeated warnings per key", () => {
    const warning = vi.fn();
    setLogger({ debug() {}, info() {}, error() {}, warning });
    try {
      const key = `k-${Math.random()}`;
      warnThrottled(key, "first");
      warnThrottled(key, "second");
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      setLogger(consoleLogger());
    }
  });
});
