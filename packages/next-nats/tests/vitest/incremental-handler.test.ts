import { afterEach, describe, expect, it, vi } from "vitest";
import NatsCacheHandler from "../../src/cache/incremental-handler.js";

describe("incremental cache handler entry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves misses and ignores writes in the Edge runtime without loading the backend", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const handler = new NatsCacheHandler({});
    expect(await handler.get("k", { kind: "FETCH" })).toBeNull();
    await expect(handler.set("k", null, {})).resolves.toBeUndefined();
    await expect(handler.revalidateTag("t")).resolves.toBeUndefined();
    await expect(handler.close()).resolves.toBeUndefined();
  });

  it("delegates to the NATS-backed handler in the Node runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const handler = new NatsCacheHandler({});
    await expect(handler.revalidateTag([])).resolves.toBeUndefined();
    expect(typeof handler.resetRequestCache).toBe("function");
  });
});
