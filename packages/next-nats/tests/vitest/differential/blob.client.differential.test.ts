import * as realClient from "@vercel/blob/client";
import * as realServer from "@vercel/blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, getNats } from "../../../src/connection.js";
import * as oursServer from "../../../src/blob/index.js";
import * as oursClient from "../../../src/blob/client.js";
import { configureBlob, createBlobRoute } from "../../../src/blob/index.js";
import { serveFetchHandler, type HttpApp } from "../../support/blob-http-adapter.js";
import { startFakeVercelBlob, type FakeVercelBlob } from "../../support/fakes/vercel-blob.js";
import { createNormalizer, observe, sha256 } from "./blob-harness.js";

type UploadOptions = {
  access: "public";
  handleUploadUrl: string;
  clientPayload?: string;
  multipart?: boolean;
  contentType?: string;
  abortSignal?: AbortSignal;
  onUploadProgress?: (event: { loaded: number; total: number; percentage: number }) => void;
};

interface ClientApi {
  upload(pathname: string, body: string | Blob | Uint8Array, options: UploadOptions): Promise<unknown>;
  put(pathname: string, body: string | Blob | Uint8Array, options: Record<string, unknown>): Promise<unknown>;
  createMultipartUpload(pathname: string, options: Record<string, unknown>): Promise<unknown>;
  uploadPart(pathname: string, body: unknown, options: Record<string, unknown>): Promise<unknown>;
  completeMultipartUpload(pathname: string, parts: unknown[], options: Record<string, unknown>): Promise<unknown>;
  generateClientTokenFromReadWriteToken(options: Record<string, unknown>): Promise<string>;
  getPayloadFromClientToken(token: string): unknown;
  handleUpload(options: Record<string, unknown>): Promise<unknown>;
}

interface ServerApi {
  head(pathname: string): Promise<unknown>;
  get(url: string, options: { access: "public" }): Promise<{ stream: ReadableStream<Uint8Array> | null } | null>;
}

interface Subject {
  readonly name: "real" | "ours";
  readonly client: ClientApi;
  readonly server: ServerApi;
  readonly origin: string;
  readonly uploadUrl: string;
  readonly appOrigin: string;
  readonly completed: unknown[];
  readonly foreignToken: (pathname: string) => Promise<string>;
  readonly tamper: (token: string) => string;
  begin(): Promise<void>;
}

interface Policy {
  allowedContentTypes?: string[];
  maximumSizeInBytes?: number;
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
  cacheControlMaxAge?: number;
  validUntil?: number;
  tokenPayload?: string | null;
  deny?: boolean;
  withCallback?: boolean;
}

interface Scenario {
  name: string;
  maskSuffix?: boolean;
  run(ctx: Context): Promise<void>;
}

interface Context {
  subject: Subject;
  record(label: string, value: unknown): void;
  attempt(label: string, run: () => Promise<unknown>): Promise<void>;
  attemptClass(label: string, run: () => Promise<unknown>): Promise<void>;
  policy(policy: Policy): string;
  settle(until: () => boolean): Promise<void>;
}

const run = Math.random().toString(36).slice(2, 8);
let sequence = 0;
let fake: FakeVercelBlob;
let realApp: HttpApp;
let oursApp: HttpApp;
const buckets: string[] = [];
const realCompleted: unknown[] = [];
const oursCompleted: unknown[] = [];
const OTHER_STORE_TOKEN = "vercel_blob_rw_otherstore_notthesecret";

function bodyOf(request: Request): Promise<{ type: string; payload: { pathname: string; clientPayload: string | null; multipart: boolean } }> {
  return request.clone().json();
}

function policyOf(clientPayload: string | null): Policy {
  return clientPayload ? (JSON.parse(clientPayload) as Policy) : {};
}

function handlerFor(
  handleUpload: (options: never) => Promise<unknown>,
  completed: unknown[],
  appOrigin: () => string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const body = await bodyOf(request);
    try {
      const result = await handleUpload({
        request,
        body,
        onBeforeGenerateToken: async (_pathname: string, clientPayload: string | null) => {
          const policy = policyOf(clientPayload);
          if (policy.deny) throw new Error("denied by policy");
          const { deny: _deny, withCallback, ...constraints } = policy;
          return { ...constraints, ...(withCallback && { callbackUrl: `${appOrigin()}/api/upload` }) };
        },
        onUploadCompleted: async (event: unknown) => {
          completed.push(event);
        },
      } as never);
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  };
}

beforeAll(async () => {
  fake = await startFakeVercelBlob();
  process.env.VERCEL_BLOB_API_URL = fake.apiUrl;
  process.env.BLOB_READ_WRITE_TOKEN = fake.readWriteToken;
  process.env.VERCEL_BLOB_RETRIES = "0";
  await connectNats({ servers: process.env.NATS_SERVERS, name: "next-nats-blob-client-differential" });

  realApp = await serveFetchHandler(
    handlerFor(realClient.handleUpload as never, realCompleted, () => realApp.origin),
  );

  const route = createBlobRoute();
  const upload = handlerFor(oursClient.handleUpload as never, oursCompleted, () => oursApp.origin);
  oursApp = await serveFetchHandler(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/upload") return upload(request);
    const path = decodeURIComponent(url.pathname.replace(/^\/blob\//, "")).split("/");
    const handler = route[request.method as "GET"];
    return handler(request, { params: Promise.resolve({ path }) });
  });
});

afterAll(async () => {
  const { jsm } = await getNats();
  await Promise.all(
    buckets.flatMap((bucket) => [`OBJ_${bucket}`, `OBJ_${bucket}_mpu`].map((stream) => jsm.streams.delete(stream).catch(() => undefined))),
  );
  await closeNats();
  await Promise.all([realApp.close(), oursApp.close(), fake.close()]);
});

function subjects(): Subject[] {
  const real: Subject = {
    name: "real",
    client: realClient as unknown as ClientApi,
    server: realServer as unknown as ServerApi,
    origin: fake.origin,
    uploadUrl: `${realApp.origin}/api/upload`,
    appOrigin: realApp.origin,
    completed: realCompleted,
    foreignToken: (pathname) =>
      realClient.generateClientTokenFromReadWriteToken({ token: OTHER_STORE_TOKEN, pathname, validUntil: Date.now() + 60_000 }),
    tamper: (token) => {
      const [prefix, store, , storeId, encoded] = [token.slice(0, 18), "", "", token.split("_")[3], token.split("_")[4]];
      void prefix;
      void store;
      const decoded = Buffer.from(encoded!, "base64").toString();
      const flipped = `${decoded[0] === "0" ? "1" : "0"}${decoded.slice(1)}`;
      return `vercel_blob_client_${storeId}_${Buffer.from(flipped).toString("base64")}`;
    },
    async begin() {
      fake.reset();
      realCompleted.length = 0;
    },
  };
  const ours: Subject = {
    name: "ours",
    client: oursClient as unknown as ClientApi,
    server: oursServer as unknown as ServerApi,
    origin: `${oursApp.origin}/blob`,
    uploadUrl: `${oursApp.origin}/api/upload`,
    appOrigin: oursApp.origin,
    completed: oursCompleted,
    async foreignToken(pathname) {
      configureBlob({ bucket: currentBucket, baseUrl: `${oursApp.origin}/blob`, secret: OTHER_STORE_TOKEN });
      try {
        return await oursClient.generateClientTokenFromReadWriteToken({ pathname, validUntil: Date.now() + 60_000 } as never);
      } finally {
        configureBlob({ bucket: currentBucket, baseUrl: `${oursApp.origin}/blob`, secret: fake.readWriteToken });
      }
    },
    tamper: (token) => {
      const index = token.lastIndexOf(".") + 1;
      return `${token.slice(0, index)}${token[index] === "A" ? "B" : "A"}${token.slice(index + 1)}`;
    },
    async begin() {
      currentBucket = `bc_${run}_${sequence++}`;
      buckets.push(currentBucket);
      configureBlob({ bucket: currentBucket, baseUrl: `${oursApp.origin}/blob`, secret: fake.readWriteToken });
      oursCompleted.length = 0;
    },
  };
  return [real, ours];
}

let currentBucket = "";

async function transcript(subject: Subject, scenario: Scenario): Promise<unknown[]> {
  await subject.begin();
  const log: unknown[] = [];
  const ctx: Context = {
    subject,
    record: (label, value) => log.push({ label, value }),
    attempt: async (label, body) => {
      log.push({ label, ...(await observe(body)) });
    },
    attemptClass: async (label, body) => {
      const observed = await observe(body);
      log.push({ label, ...("error" in observed ? { error: { sdkClass: observed.error.sdkClass, name: observed.error.name } } : observed) });
    },
    policy: (policy) => JSON.stringify(policy),
    settle: async (until) => {
      for (let i = 0; i < 100 && !until(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  };
  await scenario.run(ctx);
  return createNormalizer(subject.origin, { maskSuffix: scenario.maskSuffix }).value(log) as unknown[];
}

function bytes(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  let state = seed;
  for (let i = 0; i < size; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = state & 0xff;
  }
  return out;
}

async function stored(ctx: Context, result: unknown) {
  const url = (result as { url?: string })?.url;
  if (!url) return result;
  const got = await ctx.subject.server.get(url, { access: "public" });
  const body = got?.stream ? new Uint8Array(await new Response(got.stream).arrayBuffer()) : new Uint8Array();
  return { result, size: body.length, sha: sha256(body) };
}

function progressSummary(events: Array<{ loaded: number; total: number; percentage: number }>, size: number) {
  return {
    count: events.length >= 2 ? "two-or-more" : events.length,
    first: events[0],
    last: events.at(-1),
    monotonic: events.every((event, i) => i === 0 || event.loaded >= events[i - 1]!.loaded),
    inRange: events.every((event) => event.percentage >= 0 && event.percentage <= 100 && event.loaded <= size),
  };
}

const access = "public" as const;

const scenarios: Scenario[] = [
  {
    name: "upload through handleUpload",
    async run(ctx) {
      const { client, uploadUrl } = ctx.subject;
      await ctx.attempt("text", async () =>
        stored(ctx, await client.upload("cl/hello.txt", "hello client", { access, handleUploadUrl: uploadUrl })),
      );
      await ctx.attempt("binary with explicit content type", async () =>
        stored(ctx, await client.upload("cl/data.bin", bytes(70_000), { access, handleUploadUrl: uploadUrl, contentType: "application/x-custom" })),
      );
      await ctx.attempt("blob body", async () =>
        stored(ctx, await client.upload("cl/b.json", new Blob(['{"a":1}'], { type: "application/json" }), { access, handleUploadUrl: uploadUrl })),
      );
      await ctx.attempt("head", () => ctx.subject.server.head("cl/hello.txt"));
    },
  },
  {
    name: "upload honors server policy: suffix, overwrite and cache control",
    maskSuffix: true,
    async run(ctx) {
      const { client, uploadUrl } = ctx.subject;
      const send = (pathname: string, policy: Policy) =>
        client.upload(pathname, "v", { access, handleUploadUrl: uploadUrl, clientPayload: ctx.policy(policy) });
      await ctx.attempt("suffix", () => send("pol/s.txt", { addRandomSuffix: true }));
      await ctx.attempt("first", () => send("pol/o.txt", { allowOverwrite: false }));
      await ctx.attempt("duplicate", () => send("pol/o.txt", { allowOverwrite: false }));
      await ctx.attempt("overwrite", () => send("pol/o.txt", { allowOverwrite: true }));
      await ctx.attempt("cache control", () => send("pol/c.txt", { cacheControlMaxAge: 120 }));
      await ctx.attempt("head cache control", () => ctx.subject.server.head("pol/c.txt"));
    },
  },
  {
    name: "upload multipart",
    async run(ctx) {
      const { client, uploadUrl } = ctx.subject;
      const body = Buffer.from(bytes(10 * 1024 * 1024 + 123, 3));
      const events: Array<{ loaded: number; total: number; percentage: number }> = [];
      await ctx.attempt("multipart", async () => {
        const result = await stored(
          ctx,
          await client.upload("mp/big.bin", body, {
            access,
            handleUploadUrl: uploadUrl,
            multipart: true,
            onUploadProgress: (event) => events.push(event),
          }),
        );
        await ctx.settle(() => events.at(-1)?.percentage === 100);
        return { result, progress: progressSummary(events, body.length) };
      });
    },
  },
  {
    name: "upload progress",
    async run(ctx) {
      const { client, uploadUrl } = ctx.subject;
      const body = Buffer.from(bytes(300_000, 5));
      const events: Array<{ loaded: number; total: number; percentage: number }> = [];
      await ctx.attempt("single", async () => {
        await client.upload("pr/a.bin", body, { access, handleUploadUrl: uploadUrl, onUploadProgress: (event) => events.push(event) });
        await ctx.settle(() => events.at(-1)?.percentage === 100);
        return progressSummary(events, body.length);
      });
    },
  },
  {
    name: "upload completed callback delivery",
    async run(ctx) {
      const { client, uploadUrl, completed } = ctx.subject;
      await ctx.attempt("with callback", async () => {
        const result = await client.upload("cb/a.txt", "callback", {
          access,
          handleUploadUrl: uploadUrl,
          clientPayload: ctx.policy({ withCallback: true, tokenPayload: JSON.stringify({ user: "u1" }) }),
        });
        await ctx.settle(() => completed.length > 0);
        return { result, completed: completed.slice() };
      });
      completed.length = 0;
      await ctx.attempt("token payload defaults to client payload", async () => {
        await client.upload("cb/b.txt", "callback", {
          access,
          handleUploadUrl: uploadUrl,
          clientPayload: ctx.policy({ withCallback: true }),
        });
        await ctx.settle(() => completed.length > 0);
        return completed.slice().map((event) => ({ tokenPayload: (event as { tokenPayload?: unknown }).tokenPayload }));
      });
      completed.length = 0;
      await ctx.attempt("callback url from VERCEL_BLOB_CALLBACK_URL", async () => {
        process.env.VERCEL_BLOB_CALLBACK_URL = ctx.subject.appOrigin;
        try {
          await client.upload("cb/c.txt", "callback", { access, handleUploadUrl: uploadUrl, clientPayload: ctx.policy({}) });
          await ctx.settle(() => completed.length > 0);
        } finally {
          delete process.env.VERCEL_BLOB_CALLBACK_URL;
        }
        return completed.length;
      });
    },
  },
  {
    name: "handleUpload failures",
    async run(ctx) {
      const { client, uploadUrl } = ctx.subject;
      await ctx.attempt("denied by onBeforeGenerateToken", () =>
        client.upload("hf/a.txt", "x", { access, handleUploadUrl: uploadUrl, clientPayload: ctx.policy({ deny: true }) }),
      );
      await ctx.attempt("missing handleUploadUrl", () => client.upload("hf/a.txt", "x", { access } as never));
      await ctx.attempt("unreachable handleUploadUrl", () =>
        client.upload("hf/a.txt", "x", { access, handleUploadUrl: "http://127.0.0.1:1/none" }),
      );
      const event = async (body: unknown, headers: Record<string, string> = {}) => {
        const response = await fetch(uploadUrl, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
        return { status: response.status, body: await response.json() };
      };
      await ctx.attempt("unknown event type", () => event({ type: "blob.nope", payload: {} }));
      await ctx.attempt("completed without signature", () =>
        event({ type: "blob.upload-completed", payload: { blob: { url: "x" }, tokenPayload: null } }),
      );
      await ctx.attempt("completed with a bad signature", () =>
        event(
          { type: "blob.upload-completed", payload: { blob: { url: "x" }, tokenPayload: null } },
          { "x-vercel-signature": "00", "x-blob-signature": "00" },
        ),
      );
      await ctx.attempt("server options rejected on the client", async () => {
        const failures: Record<string, unknown> = {};
        for (const key of ["addRandomSuffix", "allowOverwrite", "cacheControlMaxAge"]) {
          failures[key] = await observe(() =>
            client.upload("hf/a.txt", "x", { access, handleUploadUrl: uploadUrl, [key]: key === "cacheControlMaxAge" ? 10 : true } as never),
          );
        }
        return failures;
      });
    },
  },
  {
    name: "client token constraints enforced by the store",
    async run(ctx) {
      const { client, server } = ctx.subject;
      const token = (extra: Record<string, unknown> = {}, pathname = "tk/a.txt") =>
        client.generateClientTokenFromReadWriteToken({ pathname, validUntil: Date.now() + 60_000, ...extra });
      await ctx.attempt("valid", async () => stored(ctx, await client.put("tk/a.txt", "ok", { access, token: await token() })));
      await ctx.attempt("expired", async () =>
        client.put("tk/a.txt", "ok", { access, token: await token({ validUntil: Date.now() - 60_000 }) }),
      );
      await ctx.attemptClass("pathname mismatch", async () => client.put("tk/other.txt", "ok", { access, token: await token() }));
      await ctx.attemptClass("content type not allowed", async () =>
        client.put("tk/a.txt", "ok", { access, token: await token({ allowedContentTypes: ["image/png"] }) }),
      );
      await ctx.attempt("content type allowed by wildcard", async () =>
        stored(ctx, await client.put("tk/w.txt", "ok", { access, token: await token({ allowedContentTypes: ["text/*"] }, "tk/w.txt") })),
      );
      await ctx.attemptClass("too large", async () =>
        client.put("tk/big.bin", bytes(2048), { access, token: await token({ maximumSizeInBytes: 1024 }, "tk/big.bin") }),
      );
      await ctx.attempt("within size limit", async () =>
        stored(ctx, await client.put("tk/small.bin", bytes(1024), { access, token: await token({ maximumSizeInBytes: 1024 }, "tk/small.bin") })),
      );
      await ctx.attemptClass("tampered token", async () => client.put("tk/a.txt", "ok", { access, token: ctx.subject.tamper(await token()) }));
      await ctx.attempt("token from another store is rejected", async () => {
        const observed = await observe(async () => client.put("tk/a.txt", "ok", { access, token: await ctx.subject.foreignToken("tk/a.txt") }));
        return { rejected: "error" in observed, viaSdkError: "error" in observed && observed.error.sdkClass !== "Error" };
      });
      await ctx.attempt("not a client token", () => client.put("tk/a.txt", "ok", { access, token: "garbage" }));
      await ctx.attempt("server options rejected", async () =>
        client.put("tk/a.txt", "ok", { access, token: await token(), addRandomSuffix: true }),
      );
      await ctx.attempt("nothing leaked by failures", async () => {
        const present: Record<string, boolean> = {};
        for (const name of ["tk/other.txt", "tk/big.bin"]) present[name] = (await observe(() => server.head(name))) && "ok" in (await observe(() => server.head(name)));
        return present;
      });
    },
  },
  {
    name: "client input validation",
    async run(ctx) {
      const { client, uploadUrl } = ctx.subject;
      const token = await client.generateClientTokenFromReadWriteToken({ pathname: "v/a.txt", validUntil: Date.now() + 60_000 });
      const put = (pathname: string, body: unknown, options: unknown) => client.put(pathname, body as never, options as never);
      await ctx.attempt("put empty body", () => put("v/a.txt", "", { access, token }));
      await ctx.attempt("put null body", () => put("v/a.txt", null, { access, token }));
      await ctx.attempt("put plain object", () => put("v/a.txt", { a: 1 }, { access, token }));
      await ctx.attempt("put empty pathname", () => put("", "x", { access, token }));
      await ctx.attempt("put long pathname", () => put("z".repeat(951), "x", { access, token }));
      await ctx.attempt("put double slash", () => put("a//b", "x", { access, token }));
      await ctx.attempt("put missing options", () => put("v/a.txt", "x", undefined));
      await ctx.attempt("put bad access", () => put("v/a.txt", "x", { access: "nope", token }));
      await ctx.attempt("put server token instead of client token", () => put("v/a.txt", "x", { access, token: "vercel_blob_rw_x_y" }));
      await ctx.attempt("put server options", async () => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries({ addRandomSuffix: true, allowOverwrite: true, cacheControlMaxAge: 5, ifMatch: '"e"' })) {
          out[key] = await observe(() => put("v/a.txt", "x", { access, token, [key]: value }));
        }
        return out;
      });
      await ctx.attempt("upload empty body", () => client.upload("v/a.txt", "" as never, { access, handleUploadUrl: uploadUrl }));
      await ctx.attempt("upload empty pathname", () => client.upload("", "x", { access, handleUploadUrl: uploadUrl }));
      await ctx.attempt("upload bad access", () => client.upload("v/a.txt", "x", { access: "nope", handleUploadUrl: uploadUrl } as never));
      await ctx.attempt("upload ifMatch", () => client.upload("v/a.txt", "x", { access, handleUploadUrl: uploadUrl, ifMatch: '"e"' } as never));
      await ctx.attempt("createMultipartUpload server options", () =>
        client.createMultipartUpload("v/a.txt", { access, token, addRandomSuffix: true }),
      );
      await ctx.attempt("createMultipartUpload empty pathname", () => client.createMultipartUpload("", { access, token }));
      await ctx.attempt("uploadPart plain object", () =>
        client.uploadPart("v/a.txt", { a: 1 }, { access, token, key: "v/a.txt", uploadId: "u", partNumber: 1 }),
      );
      await ctx.attempt("completeMultipartUpload bad access", () =>
        client.completeMultipartUpload("v/a.txt", [], { access: "nope", token, key: "v/a.txt", uploadId: "u" }),
      );
    },
  },
  {
    name: "client token payload round trip",
    async run(ctx) {
      const { client } = ctx.subject;
      const issue = async (options: Record<string, unknown>) => {
        const token = await client.generateClientTokenFromReadWriteToken({ validUntil: 4_102_444_800_000, ...options });
        return client.getPayloadFromClientToken(token);
      };
      await ctx.attempt("full", () =>
        issue({
          pathname: "tp/a.txt",
          allowedContentTypes: ["text/plain"],
          maximumSizeInBytes: 10,
          addRandomSuffix: true,
          allowOverwrite: true,
          cacheControlMaxAge: 60,
          onUploadCompleted: { callbackUrl: "https://example.com/cb", tokenPayload: "p" },
        }),
      );
      await ctx.attempt("minimal", () => issue({ pathname: "tp/b.txt" }));
      await ctx.attempt("ifMatch implies overwrite", () => issue({ pathname: "tp/c.txt", ifMatch: '"e"' }));
      await ctx.attempt("ifMatch contradicts allowOverwrite false", () =>
        issue({ pathname: "tp/c.txt", ifMatch: '"e"', allowOverwrite: false }),
      );
      await ctx.attempt("default lifetime", async () => {
        const token = await client.generateClientTokenFromReadWriteToken({ pathname: "tp/d.txt" });
        const { validUntil } = client.getPayloadFromClientToken(token) as { validUntil: number };
        const seconds = Math.round((validUntil - Date.now()) / 1000);
        return seconds >= 25 && seconds <= 35 ? "about thirty seconds" : seconds;
      });
    },
  },
];

describe("blob client differential: @vercel/blob/client with handleUpload against the fake, ours with the route", () => {
  for (const scenario of scenarios) {
    it(scenario.name, { timeout: 120_000 }, async () => {
      const [real, ours] = subjects();
      const expected = await transcript(real!, scenario);
      const received = await transcript(ours!, scenario);
      if (process.env.BLOB_DIFF_PRINT) console.info(JSON.stringify(expected, null, 1));
      expect(received).toEqual(expected);
    });
  }
});


describe("documented deviation: default callback url", () => {
  it("@vercel/blob sends no callback off Vercel, ours derives the url from the request", { timeout: 30_000 }, async () => {
    const [real, ours] = subjects();
    const delivered = async (subject: Subject) => {
      await subject.begin();
      await subject.client.upload("dv/a.txt", "x", { access, handleUploadUrl: subject.uploadUrl, clientPayload: "{}" });
      for (let i = 0; i < 50 && subject.completed.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((resolve) => setTimeout(resolve, 100));
      return subject.completed.length;
    };
    expect(await delivered(real!)).toBe(0);
    expect(await delivered(ours!)).toBe(1);
  });
});
