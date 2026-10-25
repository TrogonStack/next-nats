import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import {
  BlobAccessError,
  BlobError,
  BlobNotFoundError,
  completeMultipartUpload,
  configureBlob,
  createBlobRoute,
  createFolder,
  createMultipartUpload,
  createMultipartUploader,
  del,
  get,
  getBlobStore,
  head,
  issueSignedToken,
  list,
  put,
  presignUrl,
  uploadPart,
} from "../../src/blob/index.js";
import {
  generateClientTokenFromReadWriteToken,
  getPayloadFromClientToken,
  handleUpload,
  handleUploadPresigned,
  upload,
  uploadPresigned,
  put as clientPut,
  createMultipartUploader as clientUploader,
  type HandleUploadBody,
  type UploadCompletedEvent,
} from "../../src/blob/client.js";

const run = Math.random().toString(36).slice(2, 8);
const bucket = `blobc_${run}`;
const origin = "http://localhost:3000";
const route = createBlobRoute({ authorize: (request) => request.headers.get("x-admin") === "yes" });
const completed: UploadCompletedEvent["payload"][] = [];
const originalFetch = globalThis.fetch;

async function dispatch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/upload") {
    const body = (await request.json()) as HandleUploadBody;
    try {
      const result = await handleUpload({
        request,
        body,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          if (clientPayload === "deny") throw new Error("denied");
          return {
            allowedContentTypes: ["text/*", "application/octet-stream"],
            maximumSizeInBytes: 20 * 1024 * 1024,
            addRandomSuffix: clientPayload === "suffix",
            tokenPayload: JSON.stringify({ pathname, clientPayload }),
          };
        },
        onUploadCompleted: async (event) => {
          completed.push(event);
        },
      });
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }
  if (url.pathname === "/api/presigned") {
    const body = await request.json();
    const result = await handleUploadPresigned({
      request,
      body,
      getSignedToken: async (pathname) => ({
        token: await issueSignedToken({ pathname, operations: ["put"] }),
        urlOptions: { maximumSizeInBytes: 1024 },
      }),
      onUploadCompleted: async (event) => {
        completed.push(event);
      },
    });
    return Response.json(result);
  }
  const path = decodeURIComponent(url.pathname.replace(/^\/blob\//, "")).split("/");
  const handler = route[request.method as "GET"];
  return handler(request, { params: Promise.resolve({ path }) });
}

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_SERVERS, name: "next-nats-blob-client-test" });
  configureBlob({ bucket, baseUrl: `${origin}/blob`, secret: "client-test-secret" });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as string, init);
    return request.url.startsWith(origin) ? dispatch(request) : originalFetch(input, init);
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const { jsm } = await getNats();
  await jsm.streams.delete(`OBJ_${bucket}`).catch(() => undefined);
  await jsm.streams.delete(`OBJ_${bucket}_mpu`).catch(() => undefined);
  await closeNats();
});

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}

describe("server multipart", () => {
  it("stages parts and assembles them in order", async () => {
    const { key, uploadId } = await createMultipartUpload("mp/a.txt", { access: "public", contentType: "text/plain" });
    expect(key).toBe("mp/a.txt");
    const second = await uploadPart("mp/a.txt", "world", { access: "public", key, uploadId, partNumber: 2 });
    const first = await uploadPart("mp/a.txt", "hello ", { access: "public", key, uploadId, partNumber: 1 });
    const result = await completeMultipartUpload("mp/a.txt", [second, first], { access: "public", key, uploadId });
    expect(result.pathname).toBe("mp/a.txt");
    expect(result.contentType).toBe("text/plain");
    const stored = await get("mp/a.txt", { access: "public" });
    expect(await new Response(stored!.stream!).text()).toBe("hello world");
    await expect(completeMultipartUpload("mp/a.txt", [first], { access: "public", key, uploadId })).rejects.toBeInstanceOf(BlobError);
  });

  it("rejects an etag that does not match the staged part", async () => {
    const uploader = await createMultipartUploader("mp/bad.txt", { access: "public" });
    const part = await uploader.uploadPart(1, "x");
    await expect(uploader.complete([{ ...part, etag: '"nope"' }])).rejects.toThrow(/etag does not match/);
  });

  it("uses multipart for put and reports progress", async () => {
    const data = new Uint8Array(9 * 1024 * 1024).fill(7);
    const events: number[] = [];
    const result = await put("mp/big.bin", data, { access: "public", multipart: true, onUploadProgress: (e) => events.push(e.percentage) });
    expect((await head(result.pathname)).size).toBe(data.length);
    expect(events.at(-1)).toBe(100);
    expect(events.length).toBe(2);
  });

  it("honors addRandomSuffix and allowOverwrite", async () => {
    const a = await createMultipartUploader("mp/s.txt", { access: "public", addRandomSuffix: true });
    expect(a.key).toMatch(/^mp\/s-[a-z0-9]{10}\.txt$/);
    const part = await a.uploadPart(1, "1");
    await a.complete([part]);
    const again = await createMultipartUploader(a.key, { access: "public" });
    await expect(again.complete([await again.uploadPart(1, "2")])).rejects.toThrow(/already exists/);
  });
});

describe("folders, abort and invalid input", () => {
  it("creates folders and folds them", async () => {
    const folder = await createFolder("fold/inner");
    expect(folder.pathname).toBe("fold/inner/");
    await put("fold/file.txt", "x", { access: "public" });
    const folded = await list({ prefix: "fold/", mode: "folded" });
    expect(folded.folders).toEqual(["fold/inner/"]);
    expect(folded.blobs.map((b) => b.pathname)).toEqual(["fold/file.txt"]);
  });

  it("validates pathnames and abort signals", async () => {
    await expect(put("a//b.txt", "x", { access: "public" })).rejects.toBeInstanceOf(BlobError);
    await expect(put("x".repeat(951), "x", { access: "public" })).rejects.toBeInstanceOf(BlobError);
    const controller = new AbortController();
    controller.abort();
    await expect(put("ab/x.txt", "x", { access: "public", abortSignal: controller.signal })).rejects.toThrow(/aborted/);
    await expect(put("ab/y.txt", "x", { access: "public", optimizeImage: { width: 10 } })).rejects.toThrow(/optimizeImage/);
  });
});

describe("client tokens and uploads", () => {
  it("round trips the token payload without the server secret", async () => {
    const token = await generateClientTokenFromReadWriteToken({
      pathname: "tok/a.txt",
      maximumSizeInBytes: 10,
      allowedContentTypes: ["text/plain"],
      token: "ignored",
    });
    expect(token.startsWith("blob_client_")).toBe(true);
    const payload = getPayloadFromClientToken(token);
    expect(payload).toMatchObject({ pathname: "tok/a.txt", maximumSizeInBytes: 10, allowedContentTypes: ["text/plain"] });
    expect(payload.validUntil).toBeGreaterThan(Date.now());
  });

  it("enforces the pathname, content type, size and expiry of a client token", async () => {
    const token = await generateClientTokenFromReadWriteToken({ pathname: "tok/b.txt", maximumSizeInBytes: 5, allowedContentTypes: ["text/*"] });
    await expect(clientPut("tok/other.txt", "x", { access: "public", token, contentType: "text/plain" })).rejects.toThrow(/Pathname mismatch/);
    await expect(clientPut("tok/b.txt", "x", { access: "public", token, contentType: "image/png" })).rejects.toThrow(/Content type mismatch/);
    await expect(clientPut("tok/b.txt", "123456789", { access: "public", token, contentType: "text/plain" })).rejects.toThrow(/File is too large/);
    const ok = await clientPut("tok/b.txt", "12345", { access: "public", token, contentType: "text/plain" });
    expect(ok.pathname).toBe("tok/b.txt");
    const expired = await generateClientTokenFromReadWriteToken({ pathname: "tok/c.txt", validUntil: Date.now() - 1000 });
    await expect(clientPut("tok/c.txt", "x", { access: "public", token: expired })).rejects.toThrow(/expired/);
    await expect(clientPut("tok/c.txt", "x", { access: "public", token: "not-a-token" })).rejects.toThrow(/client token/);
    await expect(clientPut("tok/c.txt", "x", { access: "public", token, addRandomSuffix: true } as never)).rejects.toThrow(/doesn't allow/);
  });

  it("uploads through handleUpload and reports completion", async () => {
    const progress: number[] = [];
    const result = await upload("up/hello.txt", new Blob(["hello upload"], { type: "text/plain" }), {
      access: "public",
      handleUploadUrl: `${origin}/api/upload`,
      clientPayload: "suffix",
      onUploadProgress: (e) => progress.push(e.percentage),
    });
    expect(result.pathname).toMatch(/^up\/hello-[a-z0-9]{10}\.txt$/);
    expect(progress.at(-1)).toBe(100);
    expect((await head(result.pathname)).size).toBe(12);
    const event = await waitFor(() => completed.find((c) => c.blob.pathname === result.pathname));
    expect(JSON.parse(event.tokenPayload!)).toEqual({ pathname: "up/hello.txt", clientPayload: "suffix" });
  });

  it("uploads large files through multipart", async () => {
    const big = new Blob([new Uint8Array(17 * 1024 * 1024).fill(3)], { type: "application/octet-stream" });
    const result = await upload("up/big.bin", big, { access: "public", handleUploadUrl: `${origin}/api/upload`, multipart: true });
    expect((await head(result.pathname)).size).toBe(big.size);
  });

  it("surfaces a rejected token request", async () => {
    await expect(
      upload("up/denied.txt", "x", { access: "public", handleUploadUrl: `${origin}/api/upload`, clientPayload: "deny" }),
    ).rejects.toThrow(/client token/);
  });

  it("runs the client multipart helpers", async () => {
    const token = await generateClientTokenFromReadWriteToken({ pathname: "up/parts.txt", allowOverwrite: true });
    const uploader = await clientUploader("up/parts.txt", { access: "public", token, contentType: "text/plain" });
    const one = await uploader.uploadPart(1, "ab");
    const two = await uploader.uploadPart(2, "cd");
    const result = await uploader.complete([one, two]);
    expect((await head(result.pathname)).size).toBe(4);
  });

  it("rejects callbacks without a valid signature", async () => {
    const body = { type: "blob.upload-completed", payload: { blob: { url: "u", downloadUrl: "d", pathname: "p", contentType: "t", contentDisposition: "c", etag: "e" } } } as const;
    const forged = new Request(`${origin}/api/upload`, { method: "POST", headers: { "x-blob-signature": "forged" } });
    await expect(handleUpload({ request: forged, body, onBeforeGenerateToken: async () => ({}) })).rejects.toThrow(/Invalid callback signature/);
    const unsigned = new Request(`${origin}/api/upload`, { method: "POST" });
    await expect(handleUpload({ request: unsigned, body, onBeforeGenerateToken: async () => ({}) })).rejects.toThrow(/Missing callback signature/);
  });
});

describe("presigned urls", () => {
  it("uploads through handleUploadPresigned", async () => {
    const result = await uploadPresigned("ps/a.txt", new Blob(["presigned"], { type: "text/plain" }), {
      access: "public",
      handleUploadUrl: `${origin}/api/presigned`,
    });
    expect(result.pathname).toBe("ps/a.txt");
    const event = await waitFor(() => completed.find((c) => c.blob.pathname === "ps/a.txt"));
    expect(event.blob.etag).toBe(result.etag);
    await expect(
      uploadPresigned("ps/b.txt", new Blob(["x".repeat(2000)], { type: "text/plain" }), { access: "public", handleUploadUrl: `${origin}/api/presigned` }),
    ).rejects.toThrow(/File is too large/);
  });

  it("signs deletes and heads", async () => {
    await put("ps/d.txt", "bye", { access: "private" });
    const delegation = await issueSignedToken({ operations: ["delete", "head"] });
    const deny = await presignUrl(delegation, { operation: "get", pathname: "ps/d.txt", access: "private" });
    expect((await route.GET(new Request(deny.presignedUrl), { params: Promise.resolve({ path: ["ps", "d.txt"] }) })).status).toBe(403);
    const remove = await presignUrl(delegation, { operation: "delete", pathname: "ps/d.txt", access: "private" });
    const res = await route.DELETE(new Request(remove.presignedUrl, { method: "DELETE" }), { params: Promise.resolve({ path: ["ps", "d.txt"] }) });
    expect(res.status).toBe(204);
    await expect(head("ps/d.txt")).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it("requires authorization to delete without a signature", async () => {
    await put("ps/e.txt", "x", { access: "public" });
    const anon = await route.DELETE(new Request(`${origin}/blob/ps/e.txt`, { method: "DELETE" }), { params: Promise.resolve({ path: ["ps", "e.txt"] }) });
    expect(anon.status).toBe(403);
    const admin = await route.DELETE(new Request(`${origin}/blob/ps/e.txt`, { method: "DELETE", headers: { "x-admin": "yes" } }), {
      params: Promise.resolve({ path: ["ps", "e.txt"] }),
    });
    expect(admin.status).toBe(204);
    expect(BlobAccessError).toBeDefined();
    await del("ps/none.txt");
    await getBlobStore();
  });
});

describe("client entry isolation", () => {
  it("imports no server-only or node value modules", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
    const seen = new Set<string>();
    const offenders: string[] = [];
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/^(import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gms)) {
        const [, , isType, specifier] = match;
        if (isType) continue;
        if (specifier!.startsWith("node:") || specifier === "server-only" || specifier!.startsWith("@nats-io")) offenders.push(`${file}: ${specifier}`);
        else if (specifier!.startsWith(".")) visit(resolve(dirname(file), specifier!.replace(/\.js$/, ".ts")));
      }
    };
    visit(resolve(root, "blob/client.ts"));
    expect(offenders).toEqual([]);
    expect(seen.size).toBeGreaterThan(3);
  });
});
