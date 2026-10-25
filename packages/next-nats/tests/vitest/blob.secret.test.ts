import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = Symbol.for("next-nats.blob.config");

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<symbol, unknown>)[KEY];
});

describe("blob signing secret", () => {
  it("refuses a per-process secret in production so replicas agree", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BLOB_SECRET", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const { getBlobConfig, getBlobSecret } = await import("../../src/blob/config.js");
    expect(getBlobConfig().bucket).toBeTruthy();
    expect(() => getBlobSecret()).toThrow(/BLOB_SECRET/);
  });

  it("uses BLOB_SECRET in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BLOB_SECRET", "shared");
    const { getBlobSecret } = await import("../../src/blob/config.js");
    expect(getBlobSecret()).toBe("shared");
  });

  it("falls back to a stable random secret outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BLOB_SECRET", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const { getBlobSecret } = await import("../../src/blob/config.js");
    expect(getBlobSecret()).toMatch(/^[0-9a-f]{64}$/);
    expect(getBlobSecret()).toBe(getBlobSecret());
  });
});
