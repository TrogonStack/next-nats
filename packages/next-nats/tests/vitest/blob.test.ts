import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import {
  BlobNotFoundError,
  configureBlob,
  copy,
  createBlobRoute,
  del,
  get,
  head,
  list,
  put,
  issueSignedToken,
  presignUrl,
  getBlobStore,
} from "../../src/blob/index.js";

const run = Math.random().toString(36).slice(2, 8);
const bucket = `blob_${run}`;
const route = createBlobRoute();

const ctx = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) });

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_URL, name: "next-nats-blob-test" });
  configureBlob({ bucket, baseUrl: "http://localhost:3000/blob", secret: "test-secret" });
});

afterAll(async () => {
  (await getBlobStore()).destroy().catch(() => undefined);
  const { jsm } = await getNats();
  await jsm.streams.delete(`OBJ_${bucket}`).catch(() => undefined);
  await closeNats();
});

describe("blob", () => {
  it("put, head, del roundtrip with vercel shaped results", async () => {
    const res = await put("docs/hello.txt", "hello world", { access: "public" });
    expect(res.pathname).toBe("docs/hello.txt");
    expect(res.url).toBe("http://localhost:3000/blob/docs/hello.txt");
    expect(res.downloadUrl).toBe(`${res.url}?download=1`);
    expect(res.contentType).toBe("text/plain");
    expect(res.contentDisposition).toBe('inline; filename="hello.txt"');
    const meta = await head(res.url);
    expect(meta.size).toBe(11);
    expect(meta.etag).toBe(res.etag);
    await expect(put("docs/hello.txt", "x", { access: "public" })).rejects.toThrow(/already exists/);
    await put("docs/hello.txt", "bye", { access: "public", allowOverwrite: true });
    expect((await head("docs/hello.txt")).size).toBe(3);
    await del(res.url);
    await expect(head("docs/hello.txt")).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it("adds a random suffix", async () => {
    const a = await put("sfx/a.png", Buffer.from("1"), { access: "public", addRandomSuffix: true });
    expect(a.pathname).toMatch(/^sfx\/a-[A-Za-z0-9]{30}\.png$/);
    expect(a.contentType).toBe("image/png");
  });

  it("streams a large body and serves ranges", async () => {
    const data = new Uint8Array(randomBytes(6 * 1024 * 1024 + 123));
    const chunks = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < data.length; i += 700_000) c.enqueue(data.subarray(i, i + 700_000));
        c.close();
      },
    });
    const res = await put("big/data.bin", chunks, { access: "public" });
    expect((await head(res.pathname)).size).toBe(data.length);

    const full = await route.GET(new Request(res.url), ctx("big/data.bin"));
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    const body = new Uint8Array(await full.arrayBuffer());
    expect(body.length).toBe(data.length);
    expect(sha(body)).toBe(sha(data));

    const etag = full.headers.get("etag")!;
    const cached = await route.GET(new Request(res.url, { headers: { "if-none-match": etag } }), ctx("big/data.bin"));
    expect(cached.status).toBe(304);

    const mid = await route.GET(new Request(res.url, { headers: { range: "bytes=1000000-1200010" } }), ctx("big/data.bin"));
    expect(mid.status).toBe(206);
    expect(mid.headers.get("content-range")).toBe(`bytes 1000000-1200010/${data.length}`);
    const midBytes = new Uint8Array(await mid.arrayBuffer());
    expect(midBytes.length).toBe(200_011);
    expect(Buffer.compare(midBytes, data.subarray(1_000_000, 1_200_011))).toBe(0);

    const tail = await route.GET(new Request(res.url, { headers: { range: "bytes=-100" } }), ctx("big/data.bin"));
    expect(tail.status).toBe(206);
    expect(Buffer.compare(new Uint8Array(await tail.arrayBuffer()), data.subarray(data.length - 100))).toBe(0);

    const bad = await route.GET(new Request(res.url, { headers: { range: `bytes=${data.length + 5}-` } }), ctx("big/data.bin"));
    expect(bad.status).toBe(416);

    const headRes = await route.HEAD(new Request(res.url, { method: "HEAD" }), ctx("big/data.bin"));
    expect(headRes.headers.get("content-length")).toBe(String(data.length));
  }, 60_000);

  it("paginates list with prefix, cursor and folded mode", async () => {
    for (let i = 0; i < 7; i++) await put(`pg/f${i}.txt`, `v${i}`, { access: "public" });
    await put("pg/sub/x.txt", "x", { access: "public" });
    await put("pg/sub/y.txt", "y", { access: "public" });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await list({ prefix: "pg/", limit: 3, cursor });
      seen.push(...page.blobs.map((b) => b.pathname));
      cursor = page.cursor;
      pages++;
      expect(page.hasMore).toBe(Boolean(cursor));
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);

    const folded = await list({ prefix: "pg/", mode: "folded" });
    expect(folded.folders).toEqual(["pg/sub/"]);
    expect(folded.blobs).toHaveLength(7);
  });

  it("copies blobs", async () => {
    await put("cp/src.json", JSON.stringify({ a: 1 }), { access: "public" });
    const dst = await copy("cp/src.json", "cp/dst.json", { access: "public" });
    expect(dst.contentType).toBe("application/json");
    const got = await get("cp/dst.json", { access: "public" });
    expect(got?.statusCode).toBe(200);
    expect(await new Response(got!.stream!).json()).toEqual({ a: 1 });
  });

  it("handles special characters in pathnames", async () => {
    const res = await put("sp/a b%20c.txt", "ok", { access: "public" });
    const served = await route.GET(new Request(res.url), ctx("sp/a b%20c.txt"));
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("ok");
  });

  it("gates private blobs and presigned access", async () => {
    const res = await put("priv/s.txt", "secret", { access: "private" });
    expect((await route.GET(new Request(res.url), ctx("priv/s.txt"))).status).toBe(403);
    const delegation = await issueSignedToken({});
    const { presignedUrl } = await presignUrl(delegation, { operation: "get", pathname: "priv/s.txt", access: "private" });
    expect((await route.GET(new Request(presignedUrl), ctx("priv/s.txt"))).status).toBe(200);
    const forOther = await presignUrl(delegation, { operation: "get", pathname: "priv/other.txt", access: "private" });
    expect((await route.GET(new Request(forOther.presignedUrl), ctx("priv/s.txt"))).status).toBe(403);
    const tampered = presignedUrl.replace("priv%2Fs.txt", "priv%2Fx.txt");
    expect((await route.GET(new Request(tampered), ctx("priv/s.txt"))).status).toBe(403);
    expect((await get("priv/s.txt", { access: "public" }))).toBeNull();
    expect((await get("priv/s.txt", { access: "private" }))?.statusCode).toBe(200);
  });
});
