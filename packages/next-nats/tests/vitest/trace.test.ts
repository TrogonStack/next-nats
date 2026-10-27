import { headers } from "@nats-io/nats-core";
import { describe, expect, it } from "vitest";
import { TraceContext } from "../../src/trace.js";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT = "00f067aa0ba902b7";
const VALID = `00-${TRACE}-${PARENT}-01`;

describe("TraceContext", () => {
  it("parses and formats a traceparent", () => {
    const ctx = TraceContext.parse(VALID);
    expect(ctx.traceId).toBe(TRACE);
    expect(ctx.parentId).toBe(PARENT);
    expect(ctx.sampled).toBe(true);
    expect(ctx.traceparent).toBe(VALID);
    expect(String(ctx)).toBe(VALID);
  });

  it("keeps unsampled flags", () => {
    const ctx = TraceContext.parse(`00-${TRACE}-${PARENT}-00`);
    expect(ctx.sampled).toBe(false);
    expect(ctx.traceparent.endsWith("-00")).toBe(true);
  });

  it.each([
    "",
    "garbage",
    `ff-${TRACE}-${PARENT}-01`,
    `00-${"0".repeat(32)}-${PARENT}-01`,
    `00-${TRACE}-${"0".repeat(16)}-01`,
    `00-${TRACE.toUpperCase()}-${PARENT}-01`,
    `00-${TRACE.slice(1)}-${PARENT}-01`,
    `00-${TRACE}-${PARENT}-01-extra`,
    `00-${TRACE}-${PARENT}`,
    `0g-${TRACE}-${PARENT}-01`,
  ])("rejects traceparent %j", (value) => {
    expect(() => TraceContext.parse(value)).toThrow();
    expect(TraceContext.tryParse(value)).toBeUndefined();
  });

  it("accepts future versions with extra fields", () => {
    const ctx = TraceContext.parse(`01-${TRACE}-${PARENT}-01-whatever`);
    expect(ctx.traceId).toBe(TRACE);
  });

  it("normalizes and validates tracestate", () => {
    const ctx = TraceContext.parse(VALID, " congo=t61rcWkgMzE ,  rojo=00f067aa0ba902b7 ");
    expect(ctx.tracestate).toBe("congo=t61rcWkgMzE,rojo=00f067aa0ba902b7");
    expect(TraceContext.parse(VALID, "vendor@tenant=abc").tracestate).toBe("vendor@tenant=abc");
    expect(TraceContext.parse(VALID, "").tracestate).toBeUndefined();
  });

  it.each(["a", "a=", "A=b", "a=b,a=c", "a=b\tc", "=x", "a=b=c", `${"k=v,".repeat(33)}x=y`, `a=${"x".repeat(600)}`])(
    "rejects tracestate %j",
    (value) => {
      expect(() => TraceContext.parse(VALID, value)).toThrow();
    },
  );

  it("generates valid random contexts", () => {
    const a = TraceContext.generate();
    const b = TraceContext.generate({ sampled: false, tracestate: "x=y" });
    expect(TraceContext.parse(a.traceparent).equals(a)).toBe(true);
    expect(a.traceId).not.toBe(b.traceId);
    expect(b.sampled).toBe(false);
    expect(b.tracestate).toBe("x=y");
    expect(() => TraceContext.generate({ traceId: "nope" })).toThrow();
  });

  it("derives a child span in the same trace", () => {
    const ctx = TraceContext.parse(VALID, "a=b");
    const child = ctx.child();
    expect(child.traceId).toBe(ctx.traceId);
    expect(child.parentId).not.toBe(ctx.parentId);
    expect(child.tracestate).toBe("a=b");
  });

  it("reads from message headers", () => {
    const h = headers();
    h.set("traceparent", VALID);
    h.set("tracestate", "a=b");
    const ctx = TraceContext.fromHeaders(h)!;
    expect(ctx.traceparent).toBe(VALID);
    expect(ctx.tracestate).toBe("a=b");
    expect(TraceContext.fromHeaders(headers())).toBeUndefined();
    expect(TraceContext.fromHeaders(undefined)).toBeUndefined();
  });
});
