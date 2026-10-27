import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import { BlobNotFoundError, BlobPreconditionFailedError, configureBlob, del, getBlobStore, head, put } from "../../src/blob/index.js";

const bucket = `blobdel_${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_URL, name: "next-nats-blob-delete-test" });
  configureBlob({ bucket, baseUrl: "http://localhost:3000/blob", secret: "test-secret" });
});

afterAll(async () => {
  const { jsm } = await getNats();
  await jsm.streams.delete(`OBJ_${bucket}`).catch(() => undefined);
  await closeNats();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function afterFirstRead(hook: () => Promise<unknown>) {
  const store = (await getBlobStore()) as unknown as { rawInfo: (name: string) => Promise<unknown> };
  const original = store.rawInfo.bind(store);
  let fired = false;
  vi.spyOn(store, "rawInfo").mockImplementation(async (name: string) => {
    const info = await original(name);
    if (!fired) {
      fired = true;
      await hook();
    }
    return info;
  });
}

describe("del with ifMatch", () => {
  it("deletes the blob when the etag still matches", async () => {
    const first = await put("conditional/match.txt", "one", { access: "public" });
    await del(first.pathname, { ifMatch: first.etag });
    await expect(head(first.pathname)).rejects.toThrow(BlobNotFoundError);
  });

  it("rejects a stale etag", async () => {
    const first = await put("conditional/stale.txt", "one", { access: "public" });
    await put("conditional/stale.txt", "two", { access: "public", allowOverwrite: true });
    await expect(del(first.pathname, { ifMatch: first.etag })).rejects.toThrow(BlobPreconditionFailedError);
  });

  it("keeps a blob that was replaced after the etag was checked", async () => {
    const first = await put("conditional/race.txt", "one", { access: "public" });
    await afterFirstRead(() => put("conditional/race.txt", "two", { access: "public", allowOverwrite: true }));
    await expect(del(first.pathname, { ifMatch: first.etag })).rejects.toThrow(BlobPreconditionFailedError);
    const survivor = await head(first.pathname);
    expect(survivor.size).toBe(3);
    expect(survivor.etag).not.toBe(first.etag);
  });
});
