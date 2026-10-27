import { describe, expect, it } from "vitest";
import { emitLifecycle, onNatsConnectError, onNatsDisconnect, onNatsReconnect } from "../../src/lifecycle.js";

describe("lifecycle hooks", () => {
  it("delivers each event to its own hook only", () => {
    const seen: string[] = [];
    const offs = [
      onNatsConnectError(() => seen.push("connectError")),
      onNatsDisconnect(() => seen.push("disconnect")),
      onNatsReconnect(() => seen.push("reconnect")),
    ];
    emitLifecycle("disconnect", { server: "s" });
    emitLifecycle("reconnect", { server: "s", downtimeMs: 1 });
    expect(seen).toEqual(["disconnect", "reconnect"]);
    for (const off of offs) off();
  });

  it("stops delivering after unsubscribe", () => {
    let calls = 0;
    const off = onNatsDisconnect(() => calls++);
    emitLifecycle("disconnect", { server: "s" });
    off();
    emitLifecycle("disconnect", { server: "s" });
    expect(calls).toBe(1);
  });

  it("keeps delivering when a listener throws", () => {
    let calls = 0;
    const offs = [
      onNatsDisconnect(() => {
        throw new Error("boom");
      }),
      onNatsDisconnect(() => calls++),
    ];
    expect(() => emitLifecycle("disconnect", { server: "s" })).not.toThrow();
    expect(calls).toBe(1);
    for (const off of offs) off();
  });
});
