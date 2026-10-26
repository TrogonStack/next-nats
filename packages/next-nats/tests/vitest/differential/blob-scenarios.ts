import { Readable } from "node:stream";
import { bytesOf, sha256, type Scenario, type ScenarioContext } from "./blob-harness.js";

const MiB = 1024 * 1024;

function patterned(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  let state = seed;
  for (let i = 0; i < size; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
  });
}

async function view(ctx: ScenarioContext, input: string, access: "public" | "private" = "public", options: Record<string, unknown> = {}) {
  const result = await ctx.api.get(input, { access, ...options });
  if (!result) return null;
  const headers = Object.fromEntries(
    ["content-type", "content-length", "etag", "cache-control", "content-disposition"].map((name) => [name, result.headers.get(name)]),
  );
  const body = await bytesOf(result.stream);
  return { statusCode: result.statusCode, blob: result.blob, headers, bodyBytes: body.length, bodySha: sha256(body) };
}

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

function progressSummary(events: Array<{ loaded: number; total: number; percentage: number }>, size: number) {
  const first = events[0];
  const last = events.at(-1);
  return {
    count: events.length >= 2 ? "two-or-more" : events.length,
    first,
    last,
    monotonic: events.every((event, i) => i === 0 || event.loaded >= events[i - 1]!.loaded),
    inRange: events.every((event) => event.percentage >= 0 && event.percentage <= 100 && event.loaded <= size),
  };
}

const access = "public" as const;

export const scenarios: Scenario[] = [
  {
    name: "put bodies: string, Buffer, Uint8Array, ArrayBuffer, Blob, File, Readable, ReadableStream",
    async run(ctx) {
      const bytes = patterned(4096, 7);
      const bodies: Array<[string, unknown]> = [
        ["string", "hello world"],
        ["buffer", Buffer.from(bytes)],
        ["uint8", bytes],
        ["arraybuffer", bytes.buffer.slice(0) as ArrayBuffer],
        ["blob", new Blob([new Uint8Array(bytes)], { type: "application/x-custom" })],
        ["file", new File([new Uint8Array(bytes)], "ignored-name.dat", { type: "application/x-file" })],
        ["readable", Readable.from([Buffer.from(bytes)])],
        ["web-stream", chunkedStream([bytes.slice(0, 1000), bytes.slice(1000)])],
      ];
      for (const [kind, body] of bodies) {
        const pathname = `bodies/${kind}.bin`;
        await ctx.attempt(`put ${kind}`, () => ctx.api.put(pathname, body as never, { access }));
        await ctx.attempt(`head ${kind}`, () => ctx.api.head(pathname));
        await ctx.attempt(`get ${kind}`, async () => {
          const head = await ctx.api.head(pathname);
          return view(ctx, head.url);
        });
      }
    },
  },
  {
    name: "content type: explicit, extension, blob type and unknown",
    async run(ctx) {
      const cases: Array<[string, unknown, string | undefined]> = [
        ["ct/a.txt", "x", undefined],
        ["ct/b.json", "{}", undefined],
        ["ct/c.png", "x", undefined],
        ["ct/d.unknownext", "x", undefined],
        ["ct/e", "x", undefined],
        ["ct/f.txt", "x", "application/x-explicit"],
        ["ct/g", new Blob(["x"], { type: "text/csv" }), undefined],
        ["ct/h.html", new Blob(["x"], { type: "text/plain" }), undefined],
        ["ct/i.txt", "x", "text/plain; charset=utf-8"],
      ];
      for (const [pathname, body, contentType] of cases) {
        await ctx.attempt(`put ${pathname}`, () => ctx.api.put(pathname, body as never, { access, ...(contentType && { contentType }) }));
      }
    },
  },
  {
    name: "addRandomSuffix",
    maskSuffix: true,
    async run(ctx) {
      const a = await ctx.api.put("rs/file.txt", "1", { access, addRandomSuffix: true });
      const b = await ctx.api.put("rs/file.txt", "2", { access, addRandomSuffix: true });
      ctx.record("distinct", a.pathname !== b.pathname);
      ctx.record("a", a);
      ctx.record("b", b);
      const noExt = await ctx.api.put("rs/noext", "3", { access, addRandomSuffix: true });
      ctx.record("noExt", noExt);
      const plain = await ctx.api.put("rs/plain.txt", "4", { access, addRandomSuffix: false });
      ctx.record("plain", plain);
      await ctx.attempt("duplicate plain", () => ctx.api.put("rs/plain.txt", "5", { access, addRandomSuffix: false }));
      await ctx.attempt("list", () => ctx.api.list({ prefix: "rs/" }).then((r) => ({ count: r.blobs.length, hasMore: r.hasMore })));
    },
  },
  {
    name: "allowOverwrite",
    async run(ctx) {
      await ctx.attempt("first", () => ctx.api.put("ow/a.txt", "one", { access }));
      await ctx.attempt("duplicate without option", () => ctx.api.put("ow/a.txt", "two", { access }));
      await ctx.attempt("duplicate allowOverwrite false", () => ctx.api.put("ow/a.txt", "two", { access, allowOverwrite: false }));
      await ctx.attempt("overwrite", () => ctx.api.put("ow/a.txt", "three", { access, allowOverwrite: true }));
      await ctx.attempt("head after overwrite", () => ctx.api.head("ow/a.txt"));
      await ctx.attempt("body after overwrite", async () => view(ctx, (await ctx.api.head("ow/a.txt")).url));
    },
  },
  {
    name: "cacheControlMaxAge",
    async run(ctx) {
      await ctx.attempt("put default", () => ctx.api.put("cc/default.txt", "x", { access }));
      await ctx.attempt("put 60", () => ctx.api.put("cc/sixty.txt", "x", { access, cacheControlMaxAge: 60 }));
      await ctx.attempt("put 0", () => ctx.api.put("cc/zero.txt", "x", { access, cacheControlMaxAge: 0 }));
      for (const name of ["default", "sixty", "zero"]) {
        await ctx.attempt(`head ${name}`, () => ctx.api.head(`cc/${name}.txt`));
        await ctx.attempt(`get ${name}`, async () => view(ctx, (await ctx.api.head(`cc/${name}.txt`)).url));
      }
    },
  },
  {
    name: "head, get and del on missing blobs",
    async run(ctx) {
      await ctx.attempt("head missing", () => ctx.api.head("missing/a.txt"));
      await ctx.attempt("get missing by url", () => ctx.api.get(`${ctx.origin}/missing/a.txt`, { access }));
      await ctx.attempt("del missing", () => ctx.api.del("missing/a.txt"));
      await ctx.attempt("del missing url", () => ctx.api.del(`${ctx.origin}/missing/b.txt`));
      await ctx.attempt("copy missing source", () => ctx.api.copy("missing/a.txt", "missing/b.txt", { access }));
      await ctx.attempt("rename missing source", () => ctx.api.rename("missing/a.txt", "missing/b.txt", { access }));
    },
  },
  {
    name: "head, get and del accept urls and pathnames",
    async run(ctx) {
      const put = await ctx.api.put("urls/a.txt", "hello", { access });
      await ctx.attempt("head url", () => ctx.api.head(put.url));
      await ctx.attempt("head pathname", () => ctx.api.head("urls/a.txt"));
      await ctx.attempt("head downloadUrl", () => ctx.api.head(put.downloadUrl));
      await ctx.attempt("get url", () => view(ctx, put.url));
      await ctx.attempt("get downloadUrl", () => view(ctx, put.downloadUrl));
      await ctx.attempt("del by url", () => ctx.api.del(put.url));
      await ctx.attempt("head after del", () => ctx.api.head("urls/a.txt"));
      const again = await ctx.api.put("urls/b.txt", "hello", { access });
      await ctx.attempt("del by pathname", () => ctx.api.del("urls/b.txt"));
      await ctx.attempt("head after del 2", () => ctx.api.head(again.url));
    },
  },
  {
    name: "del with several targets",
    async run(ctx) {
      const items = await Promise.all(["many/a.txt", "many/b.txt", "many/c.txt"].map((p) => ctx.api.put(p, p, { access })));
      await ctx.attempt("del array", () => ctx.api.del([items[0]!.url, items[1]!.url]));
      await ctx.attempt("list", () => ctx.api.list({ prefix: "many/" }));
      await ctx.attempt("del array with missing", () => ctx.api.del([items[2]!.url, `${ctx.origin}/many/zzz.txt`]));
      await ctx.attempt("list after", () => ctx.api.list({ prefix: "many/" }));
    },
  },
  {
    name: "get: shape, download url, ifNoneMatch and private access",
    async run(ctx) {
      const put = await ctx.api.put("g/file.txt", "payload", { access, contentType: "text/plain" });
      await ctx.attempt("get 200", () => view(ctx, put.url));
      await ctx.attempt("get 304", () => view(ctx, put.url, access, { ifNoneMatch: put.etag }));
      await ctx.attempt("get stale etag", () => view(ctx, put.url, access, { ifNoneMatch: '"stale"' }));
      await ctx.attempt("get download url", () => view(ctx, put.downloadUrl));
      const priv = await ctx.api.put("g/private.txt", "secret", { access: "private" });
      await ctx.attempt("put private result", async () => priv);
      await ctx.attempt("get private", () => view(ctx, priv.url, "private"));
      await ctx.attempt("head private", () => ctx.api.head(priv.url));
    },
  },
  {
    name: "list: prefix, limit, cursor walk, folded and expanded",
    async run(ctx) {
      const names = ["l/a.txt", "l/b.txt", "l/c.txt", "l/d/x.txt", "l/d/y.txt", "l/d/e/z.txt", "l/e.txt", "m/a.txt", "top.txt"];
      for (const name of names) await ctx.api.put(name, name, { access });
      await ctx.attempt("all", () => ctx.api.list());
      await ctx.attempt("prefix l/", () => ctx.api.list({ prefix: "l/" }));
      await ctx.attempt("prefix l/d", () => ctx.api.list({ prefix: "l/d" }));
      await ctx.attempt("prefix none", () => ctx.api.list({ prefix: "nothing/" }));
      await ctx.attempt("limit 3", () => ctx.api.list({ limit: 3 }));
      await ctx.attempt("limit 1", () => ctx.api.list({ limit: 1, prefix: "l/" }));
      await ctx.attempt("folded root", () => ctx.api.list({ mode: "folded" }));
      await ctx.attempt("folded l/", () => ctx.api.list({ mode: "folded", prefix: "l/" }));
      await ctx.attempt("folded limit 2", () => ctx.api.list({ mode: "folded", prefix: "l/", limit: 2 }));
      await ctx.attempt("expanded", () => ctx.api.list({ mode: "expanded", prefix: "l/" }));
      await ctx.attempt("walk", async () => {
        const seen: string[][] = [];
        let cursor: string | undefined;
        do {
          const page = await ctx.api.list({ limit: 2, ...(cursor && { cursor }) });
          seen.push(page.blobs.map((b) => b.pathname));
          cursor = page.hasMore ? page.cursor : undefined;
        } while (cursor);
        return seen;
      });
      await ctx.attempt("folded walk", async () => {
        const seen: unknown[] = [];
        let cursor: string | undefined;
        do {
          const page = await ctx.api.list({ limit: 2, mode: "folded", prefix: "l/", ...(cursor && { cursor }) });
          seen.push({ blobs: page.blobs.map((b) => b.pathname), folders: (page as { folders: string[] }).folders });
          cursor = page.hasMore ? page.cursor : undefined;
        } while (cursor);
        return seen;
      });
    },
  },
  {
    name: "list entries carry size and etag",
    async run(ctx) {
      await ctx.api.put("le/a.bin", Buffer.from(patterned(100)), { access });
      await ctx.attempt("list", () => ctx.api.list({ prefix: "le/" }));
    },
  },
  {
    name: "copy and rename",
    async run(ctx) {
      await ctx.api.put("cp/src.txt", "source", { access, contentType: "text/x-source", cacheControlMaxAge: 120 });
      await ctx.attempt("copy", () => ctx.api.copy("cp/src.txt", "cp/dst.txt", { access }));
      await ctx.attempt("head copy", () => ctx.api.head("cp/dst.txt"));
      await ctx.attempt("copy onto existing", () => ctx.api.copy("cp/src.txt", "cp/dst.txt", { access }));
      await ctx.attempt("copy overwrite", () => ctx.api.copy("cp/src.txt", "cp/dst.txt", { access, allowOverwrite: true }));
      await ctx.attempt("copy content type override", () => ctx.api.copy("cp/src.txt", "cp/typed.txt", { access, contentType: "text/x-other" }));
      await ctx.attempt("copy by url", async () => ctx.api.copy((await ctx.api.head("cp/src.txt")).url, "cp/by-url.txt", { access }));
      await ctx.attempt("rename", () => ctx.api.rename("cp/src.txt", "cp/renamed.txt", { access }));
      await ctx.attempt("head source after rename", () => ctx.api.head("cp/src.txt"));
      await ctx.attempt("head renamed", () => ctx.api.head("cp/renamed.txt"));
      await ctx.attempt("list", () => ctx.api.list({ prefix: "cp/" }).then((r) => r.blobs.map((b) => b.pathname)));
    },
  },
  {
    name: "copy with addRandomSuffix",
    maskSuffix: true,
    async run(ctx) {
      await ctx.api.put("cs/src.txt", "source", { access });
      await ctx.attempt("copy suffix", () => ctx.api.copy("cs/src.txt", "cs/dst.txt", { access, addRandomSuffix: true }));
      await ctx.attempt("copy suffix again", () => ctx.api.copy("cs/src.txt", "cs/dst.txt", { access, addRandomSuffix: true }));
      await ctx.attempt("count", () => ctx.api.list({ prefix: "cs/" }).then((r) => r.blobs.length));
    },
  },
  {
    name: "createFolder and folded listing",
    async run(ctx) {
      await ctx.attempt("create", () => ctx.api.createFolder("folder/inner", { access }));
      await ctx.attempt("create trailing slash", () => ctx.api.createFolder("folder/other/", { access }));
      await ctx.attempt("create again", () => ctx.api.createFolder("folder/inner", { access }));
      await ctx.api.put("folder/file.txt", "x", { access });
      await ctx.attempt("folded", () => ctx.api.list({ prefix: "folder/", mode: "folded" }));
      await ctx.attempt("expanded", () => ctx.api.list({ prefix: "folder/" }).then((r) => r.blobs.map((b) => b.pathname)));
    },
  },
  {
    name: "input validation",
    async run(ctx) {
      await ctx.attempt("empty pathname", () => ctx.api.put("", "x", { access }));
      await ctx.attempt("long pathname", () => ctx.api.put("x".repeat(951), "x", { access }));
      await ctx.attempt("max pathname", () => ctx.api.put("y".repeat(950), "x", { access }));
      await ctx.attempt("double slash", () => ctx.api.put("a//b.txt", "x", { access }));
      await ctx.attempt("bad access", () => ctx.api.put("v/a.txt", "x", { access: "nope" as never }));
      await ctx.attempt("missing access", () => ctx.api.put("v/a.txt", "x", {} as never));
      await ctx.attempt("missing options", () => ctx.api.put("v/a.txt", "x", undefined as never));
      await ctx.attempt("null body", () => ctx.api.put("v/a.txt", null as never, { access }));
      await ctx.attempt("undefined body", () => ctx.api.put("v/a.txt", undefined as never, { access }));
      await ctx.attempt("empty string body", () => ctx.api.put("v/empty.txt", "", { access }));
      await ctx.attempt("empty buffer body", () => ctx.api.put("v/empty-buffer.txt", Buffer.alloc(0), { access }));
      await ctx.attempt("empty blob body", () => ctx.api.put("v/empty-blob.txt", new Blob([]), { access }));
      await ctx.attempt("plain object body", () => ctx.api.put("v/obj.txt", { a: 1 } as never, { access }));
      await ctx.attempt("ifMatch with allowOverwrite false", () => ctx.api.put("v/b.txt", "x", { access, ifMatch: '"x"', allowOverwrite: false }));
      await ctx.attempt("list limit zero is ignored", () => ctx.api.list({ limit: 0 }).then((r) => r.blobs.length));
      await ctx.attempt("list big limit", () => ctx.api.list({ limit: 100000 }).then((r) => r.hasMore));
      await ctx.attempt("copy bad access", () => ctx.api.copy("v/a.txt", "v/c.txt", { access: "nope" as never }));
      await ctx.attempt("copy missing options", () => ctx.api.copy("v/a.txt", "v/c.txt", undefined as never));
      await ctx.attempt("copy double slash", () => ctx.api.copy("v/a.txt", "v//c.txt", { access }));
      await ctx.attempt("copy long destination", () => ctx.api.copy("v/a.txt", "z".repeat(951), { access }));
      await ctx.attempt("rename bad access", () => ctx.api.rename("v/a.txt", "v/c.txt", { access: "nope" as never }));
      await ctx.attempt("rename missing options", () => ctx.api.rename("v/a.txt", "v/c.txt", undefined as never));
      await ctx.attempt("get empty", () => ctx.api.get("", { access }));
      await ctx.attempt("get missing options", () => ctx.api.get("v/a.txt", undefined as never));
      await ctx.attempt("get bad access", () => ctx.api.get("v/a.txt", { access: "nope" as never }));
      await ctx.attempt("get foreign url", () => ctx.api.get("https://example.com/v/a.txt", { access }));
      await ctx.attempt("del ifMatch with several urls", () => ctx.api.del(["v/a.txt", "v/b.txt"], { ifMatch: '"x"' } as never));
      await ctx.attempt("multipart bad access", () => ctx.api.createMultipartUpload("v/a.txt", { access: "nope" as never }));
      await ctx.attempt("multipart long pathname", () => ctx.api.createMultipartUpload("z".repeat(951), { access }));
      await ctx.attempt("multipart empty pathname", () => ctx.api.createMultipartUpload("", { access }));
    },
  },
  {
    name: "ifMatch on put, copy and del",
    async run(ctx) {
      const first = await ctx.api.put("im/a.txt", "one", { access });
      await ctx.attempt("mismatch", () => ctx.api.put("im/a.txt", "two", { access, ifMatch: '"wrong"' }));
      await ctx.attempt("match", () => ctx.api.put("im/a.txt", "two", { access, ifMatch: first.etag }));
      await ctx.attempt("stale after match", () => ctx.api.put("im/a.txt", "three", { access, ifMatch: first.etag }));
      await ctx.attempt("missing target", () => ctx.api.put("im/none.txt", "x", { access, ifMatch: first.etag }));
      await ctx.attempt("del mismatch", () => ctx.api.del("im/a.txt", { ifMatch: '"wrong"' } as never));
      await ctx.attempt("still there", () => ctx.api.head("im/a.txt").then((h) => h.size));
      const current = await ctx.api.head("im/a.txt");
      await ctx.attempt("del match", () => ctx.api.del(current.url, { ifMatch: current.etag } as never));
      await ctx.attempt("gone", () => ctx.api.head("im/a.txt"));
    },
  },
  {
    name: "abortSignal",
    async run(ctx) {
      const pre = new AbortController();
      pre.abort();
      const signal = pre.signal;
      await ctx.attempt("put", () => ctx.api.put("ab/a.txt", "x", { access, abortSignal: signal }));
      await ctx.attempt("head", () => ctx.api.head("ab/a.txt", { abortSignal: signal } as never));
      await ctx.attempt("list", () => ctx.api.list({ abortSignal: signal }));
      await ctx.attempt("del", () => ctx.api.del("ab/a.txt", { abortSignal: signal }));
      await ctx.attempt("copy", () => ctx.api.copy("ab/a.txt", "ab/b.txt", { access, abortSignal: signal }));
      await ctx.attempt("get", () => ctx.api.get(`${ctx.origin}/ab/a.txt`, { access, abortSignal: signal }));
      await ctx.attempt("nothing stored", () => ctx.api.list({ prefix: "ab/" }).then((r) => r.blobs.length));
    },
  },
  {
    name: "abortSignal during a streaming upload",
    async run(ctx) {
      const controller = new AbortController();
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          if (sent === 2) controller.abort();
          if (sent > 6) return stream.close();
          sent++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          stream.enqueue(patterned(64 * 1024, sent));
        },
      });
      await ctx.attempt("abort mid flight", () => ctx.api.put("ab/stream.bin", body, { access, abortSignal: controller.signal }));
      await ctx.attempt("nothing stored", () => ctx.api.list({ prefix: "ab/" }).then((r) => r.blobs.length));
    },
  },
  {
    name: "onUploadProgress",
    async run(ctx) {
      for (const [label, size] of [
        ["tiny", 5],
        ["small", 64 * 1024],
        ["large", 3 * MiB],
      ] as const) {
        const events: Array<{ loaded: number; total: number; percentage: number }> = [];
        await ctx.attempt(`put ${label}`, async () => {
          await ctx.api.put(`pg/${label}.bin`, Buffer.from(patterned(size)), { access, onUploadProgress: (e) => events.push(e) });
          await settle();
          return progressSummary(events, size);
        });
      }
      const streamed: Array<{ loaded: number; total: number; percentage: number }> = [];
      await ctx.attempt("stream body", async () => {
        const chunks = [patterned(100_000, 1), patterned(100_000, 2), patterned(50_000, 3)];
        await ctx.api.put("pg/stream.bin", chunkedStream(chunks), { access, onUploadProgress: (e) => streamed.push(e) });
        await settle();
        return progressSummary(streamed, 250_000);
      });
    },
  },
  {
    name: "multipart put: several parts, buffers and streams",
    async run(ctx) {
      const size = 20 * MiB + 123;
      const data = patterned(size, 11);
      const events: Array<{ loaded: number; total: number; percentage: number }> = [];
      await ctx.attempt("multipart buffer", async () => {
        const result = await ctx.api.put("mp/big.bin", Buffer.from(data), {
          access,
          multipart: true,
          contentType: "application/octet-stream",
          onUploadProgress: (e) => events.push(e),
        });
        const stored = await view(ctx, result.url);
        await settle();
        return { result, stored: stored && { bodyBytes: stored.bodyBytes, bodySha: stored.bodySha }, progress: progressSummary(events, size) };
      });
      await ctx.attempt("multipart stream", async () => {
        const chunks: Uint8Array[] = [];
        for (let offset = 0; offset < size; offset += 3 * MiB) chunks.push(data.slice(offset, Math.min(size, offset + 3 * MiB)));
        const result = await ctx.api.put("mp/stream.bin", chunkedStream(chunks), { access, multipart: true });
        const stored = await view(ctx, result.url);
        return { result, bodyBytes: stored?.bodyBytes, bodySha: stored?.bodySha };
      });
      await ctx.attempt("multipart duplicate", () => ctx.api.put("mp/big.bin", "x", { access, multipart: true }));
      await ctx.attempt("multipart small body", async () => {
        const result = await ctx.api.put("mp/small.bin", "tiny", { access, multipart: true });
        return { result, head: await ctx.api.head(result.url) };
      });
    },
  },
  {
    name: "manual multipart: out of order parts, key and upload id handling",
    maskSuffix: true,
    async run(ctx) {
      const a = patterned(MiB, 21);
      const b = patterned(MiB, 22);
      const c = patterned(500, 23);
      const upload = await ctx.api.createMultipartUpload("mm/a.bin", { access, contentType: "application/x-mm" });
      ctx.record("keys", { key: upload.key, hasUploadId: typeof upload.uploadId === "string" && upload.uploadId.length > 0 });
      const part3 = await ctx.api.uploadPart("mm/a.bin", Buffer.from(c), { access, key: upload.key, uploadId: upload.uploadId, partNumber: 3 });
      const part1 = await ctx.api.uploadPart("mm/a.bin", Buffer.from(a), { access, key: upload.key, uploadId: upload.uploadId, partNumber: 1 });
      const part2 = await ctx.api.uploadPart("mm/a.bin", Buffer.from(b), { access, key: upload.key, uploadId: upload.uploadId, partNumber: 2 });
      ctx.record("partShapes", [part1, part2, part3].map((p) => ({ partNumber: p.partNumber, keys: Object.keys(p).sort() })));
      await ctx.attempt("complete", async () => {
        const result = await ctx.api.completeMultipartUpload("mm/a.bin", [part3, part1, part2], { access, key: upload.key, uploadId: upload.uploadId });
        const stored = await view(ctx, result.url);
        return { result, bodyBytes: stored?.bodyBytes, bodySha: stored?.bodySha, expected: sha256(Buffer.concat([a, b, c])) };
      });
      await ctx.attempt("complete unknown part", async () => {
        const next = await ctx.api.createMultipartUpload("mm/b.bin", { access });
        return ctx.api.completeMultipartUpload("mm/b.bin", [{ partNumber: 1, etag: "bogus" }], { access, key: next.key, uploadId: next.uploadId });
      });
      await ctx.attempt("uploader helper", async () => {
        const uploader = await ctx.api.createMultipartUploader("mm/c.bin", { access, addRandomSuffix: true });
        const p1 = await uploader.uploadPart(1, "hello ");
        const p2 = await uploader.uploadPart(2, "world");
        const result = await uploader.complete([p2, p1]);
        const stored = await view(ctx, result.url);
        return { result, body: stored?.bodyBytes, sha: stored?.bodySha, expected: sha256(Buffer.from("hello world")) };
      });
      await ctx.attempt("duplicate target", async () => {
        const uploader = await ctx.api.createMultipartUploader("mm/a.bin", { access });
        const p1 = await uploader.uploadPart(1, "x");
        return uploader.complete([p1]);
      });
    },
  },
  {
    name: "large non-multipart body round trip",
    async run(ctx) {
      const data = patterned(12 * MiB + 17, 31);
      await ctx.attempt("put", async () => {
        const result = await ctx.api.put("big/single.bin", Buffer.from(data), { access });
        const stored = await view(ctx, result.url);
        return { result, bodyBytes: stored?.bodyBytes, bodySha: stored?.bodySha, expected: sha256(data) };
      });
      await ctx.attempt("head", () => ctx.api.head("big/single.bin"));
    },
  },
  {
    name: "pathnames with special characters",
    async run(ctx) {
      const names = ["sp/with space.txt", "sp/ünïcode.txt", "sp/a+b.txt", "sp/q%3Fmark.txt", "sp/hash#tag.txt", "sp/amp&eq=.txt"];
      for (const name of names) {
        await ctx.attempt(`put ${name}`, () => ctx.api.put(name, name, { access }));
        await ctx.attempt(`head ${name}`, () => ctx.api.head(name));
        await ctx.attempt(`get ${name}`, async () => view(ctx, (await ctx.api.head(name)).url));
      }
      await ctx.attempt("list", () => ctx.api.list({ prefix: "sp/" }).then((r) => r.blobs.map((b) => b.pathname)));
    },
  },
];
