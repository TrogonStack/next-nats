import { afterAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, type ConnectionState } from "../../src/connection.js";
import { createLivenessHandler, createReadinessHandler, livenessChecks, readinessChecks } from "../../src/health/index.js";

const state = (patch: Partial<ConnectionState>): ConnectionState => ({
  phase: "connected",
  since: 0,
  shuttingDown: false,
  initializing: false,
  ...patch,
});

const passes = (checks: { pass: boolean }[]) => checks.every((c) => c.pass);

describe("readiness state", () => {
  it("is ready when connected", () => {
    expect(passes(readinessChecks(state({})))).toBe(true);
  });

  it("is not ready before the first connection", () => {
    expect(passes(readinessChecks(state({ phase: "idle" })))).toBe(false);
  });

  it("tolerates a short reconnect and fails after the grace window", () => {
    const options = { graceMs: 1000, now: () => 500 };
    expect(passes(readinessChecks(state({ phase: "reconnecting", since: 0 }), options))).toBe(true);
    expect(passes(readinessChecks(state({ phase: "reconnecting", since: 0 }), { ...options, now: () => 1500 }))).toBe(false);
  });

  it("is not ready once closed or shutting down", () => {
    expect(passes(readinessChecks(state({ phase: "closed" })))).toBe(false);
    expect(passes(readinessChecks(state({ shuttingDown: true })))).toBe(false);
  });
});

describe("liveness state", () => {
  it("fails only while initializing and ignores the connection", () => {
    expect(passes(livenessChecks(state({ initializing: true })))).toBe(false);
    expect(passes(livenessChecks(state({ phase: "closed", shuttingDown: true })))).toBe(true);
    expect(passes(livenessChecks(state({ phase: "idle" })))).toBe(true);
  });
});

describe("handlers", () => {
  afterAll(() => closeNats());

  it("answers status only", async () => {
    const live = createLivenessHandler({ state: () => state({}) });
    const response = live();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("lists checks with ?verbose", async () => {
    const live = createLivenessHandler({ state: () => state({ initializing: true }) });
    const response = live(new Request("http://x/-/liveness?verbose"));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("initialization: fail");
  });

  it("flips from not ready with a bogus server, to ready, to not ready on shutdown", async () => {
    const ready = createReadinessHandler();
    await expect(connectNats({ servers: "nats://127.0.0.1:1", timeout: 500 })).rejects.toThrow();
    const down = ready();
    expect(down.status).toBe(503);
    expect(await down.text()).toBe("not ready");

    await connectNats({ servers: process.env.NATS_SERVERS });
    expect(ready().status).toBe(200);

    const closing = closeNats();
    expect(ready().status).toBe(503);
    expect(await ready(new Request("http://x/-/readiness?verbose")).text()).toContain("shutdown: fail");
    await closing;
    expect(ready().status).toBe(503);
  });
});
