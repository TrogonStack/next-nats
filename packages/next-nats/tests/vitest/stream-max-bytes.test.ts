import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { natsConfig, natsConfigFromEnv } from "../../src/config.js";
import { closeNats, connectNats, getNats, openKv, openObj } from "../../src/connection.js";
import { createCronRuntime } from "../../src/cron/index.js";
import { deadLetterCaptureSpec, ensureDeadLetterCaptureStream } from "../../src/dead-letter.js";
import { configureBlob, getBlobStore } from "../../src/blob/index.js";
import { provision } from "../../src/queue/store.js";
import { ByteSize, byteSize, SYNADIA_DEFAULT_STREAM_MAX_BYTES } from "../../src/size.js";
import { ensureStream, defineStream } from "../../src/streams.js";

const MIB = 1_048_576;
const GIB = MIB * 1024;

describe("ByteSize", () => {
  it("parses binary and decimal units", () => {
    expect(byteSize("128MiB").bytes).toBe(128 * MIB);
    expect(byteSize("1GiB").bytes).toBe(GIB);
    expect(byteSize("1.5 KiB").bytes).toBe(1536);
    expect(byteSize("10MB").bytes).toBe(10_000_000);
    expect(byteSize("512").bytes).toBe(512);
    expect(byteSize(2048).bytes).toBe(2048);
  });

  it("passes a ByteSize through and compares by value", () => {
    const size = ByteSize.ofBytes(64);
    expect(byteSize(size)).toBe(size);
    expect(size.equals(byteSize("64B"))).toBe(true);
  });

  it.each(["", "abc", "12XB", "-5MiB", "0", "MiB"])("rejects %j", (value) => {
    expect(() => byteSize(value)).toThrow(/size/i);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %j bytes", (value) => {
    expect(() => byteSize(value)).toThrow(/size/i);
  });
});

describe("streamMaxBytes configuration", () => {
  it("is unset by default", () => {
    expect(natsConfig().streamMaxBytes).toBeUndefined();
    expect(natsConfigFromEnv({}).streamMaxBytes).toBeUndefined();
  });

  it("accepts bytes, text and a ByteSize in code", () => {
    expect(natsConfig({ streamMaxBytes: 4096 }).streamMaxBytes).toBe(4096);
    expect(natsConfig({ streamMaxBytes: "1GiB" }).streamMaxBytes).toBe(GIB);
    expect(natsConfig({ streamMaxBytes: ByteSize.ofBytes(7) }).streamMaxBytes).toBe(7);
  });

  it("reads NATS_STREAM_MAX_BYTES with size text or bytes", () => {
    expect(natsConfigFromEnv({ NATS_STREAM_MAX_BYTES: "256MiB" }).streamMaxBytes).toBe(256 * MIB);
    expect(natsConfigFromEnv({ NATS_STREAM_MAX_BYTES: "1048576" }).streamMaxBytes).toBe(MIB);
    expect(natsConfigFromEnv({ NATS_STREAM_MAX_BYTES: "" }).streamMaxBytes).toBeUndefined();
  });

  it("rejects an invalid NATS_STREAM_MAX_BYTES naming the variable", () => {
    expect(() => natsConfigFromEnv({ NATS_STREAM_MAX_BYTES: "lots" })).toThrow(/NATS_STREAM_MAX_BYTES/);
    expect(() => natsConfigFromEnv({ NATS_STREAM_MAX_BYTES: "0" })).toThrow(/NATS_STREAM_MAX_BYTES/);
  });

  it("defaults to 128 MiB with the synadia preset", () => {
    expect(SYNADIA_DEFAULT_STREAM_MAX_BYTES).toBe(128 * MIB);
    expect(natsConfig({ synadia: true }).streamMaxBytes).toBe(128 * MIB);
    expect(natsConfigFromEnv({ NATS_SYNADIA: "eu" }).streamMaxBytes).toBe(128 * MIB);
  });

  it("lets explicit configuration win over the synadia default", () => {
    expect(natsConfig({ synadia: true, streamMaxBytes: "1GiB" }).streamMaxBytes).toBe(GIB);
    expect(natsConfigFromEnv({ NATS_SYNADIA: "true", NATS_STREAM_MAX_BYTES: "64MiB" }).streamMaxBytes).toBe(64 * MIB);
  });
});

const run = Math.random().toString(36).slice(2, 8);
const LIMIT = 2 * MIB;
const streams: string[] = [];
const track = (name: string) => {
  streams.push(name);
  return name;
};

async function maxBytesOf(stream: string): Promise<number | undefined> {
  const { jsm } = await getNats();
  return (await jsm.streams.info(stream)).config.max_bytes;
}

describe("max_bytes on provisioned resources", () => {
  beforeAll(async () => {
    await connectNats({ servers: process.env.NATS_URL, streamMaxBytes: LIMIT, name: "next-nats-max-bytes-test" });
  });

  afterAll(async () => {
    const { jsm } = await getNats();
    for (const n of streams) await jsm.streams.delete(n).catch(() => undefined);
    await closeNats();
  });

  it("fills max_bytes when ensureStream creates a stream", async () => {
    const name = track(`MB_ENSURE_${run}`);
    await ensureStream({ name, subjects: [`mb.ensure.${run}.>`] });
    expect(await maxBytesOf(name)).toBe(LIMIT);
  });

  it("lets the spec override the default", async () => {
    const name = track(`MB_SPEC_${run}`);
    await ensureStream({ name, subjects: [`mb.spec.${run}.>`], maxBytes: 5 * MIB });
    expect(await maxBytesOf(name)).toBe(5 * MIB);
    const raw = track(`MB_RAW_${run}`);
    await ensureStream({ name: raw, subjects: [`mb.raw.${run}.>`], max_bytes: -1 });
    expect(await maxBytesOf(raw)).toBe(-1);
  });

  it("keeps the max_bytes of an existing stream when updating", async () => {
    const name = track(`MB_KEEP_${run}`);
    const { jsm } = await getNats();
    await jsm.streams.add({ name, subjects: [`mb.keep.${run}.>`], max_bytes: 9 * MIB });
    await ensureStream({ name, subjects: [`mb.keep.${run}.>`, `mb.keep2.${run}.>`] });
    expect((await jsm.streams.info(name)).config.subjects).toContain(`mb.keep2.${run}.>`);
    expect(await maxBytesOf(name)).toBe(9 * MIB);
  });

  it("does not cap an existing unlimited stream when updating", async () => {
    const name = track(`MB_UNLIM_${run}`);
    const { jsm } = await getNats();
    await jsm.streams.add({ name, subjects: [`mb.unlim.${run}.>`] });
    await ensureStream({ name, subjects: [`mb.unlim.${run}.>`, `mb.unlim2.${run}.>`] });
    expect(await maxBytesOf(name)).toBe(-1);
  });

  it("applies an explicit maxBytes when updating an existing stream", async () => {
    const name = track(`MB_EXPL_${run}`);
    const { jsm } = await getNats();
    await jsm.streams.add({ name, subjects: [`mb.expl.${run}.>`], max_bytes: 9 * MIB });
    await ensureStream({ name, subjects: [`mb.expl.${run}.>`], maxBytes: 3 * MIB });
    expect(await maxBytesOf(name)).toBe(3 * MIB);
  });

  it("fills max_bytes for defineStream in startup mode", async () => {
    const name = track(`MB_DEFINE_${run}`);
    await defineStream({ name, subjects: [`mb.define.${run}.>`] }).ensure();
    expect(await maxBytesOf(name)).toBe(LIMIT);
  });

  it("fills max_bytes for the dead letter capture stream", async () => {
    const name = track(`MB_DLQ_${run}`);
    const streams = [`MB_DLQ_SRC_${run}`];
    expect(deadLetterCaptureSpec({ name, streams }).maxBytes).toBeUndefined();
    await ensureDeadLetterCaptureStream({ name, streams });
    expect(await maxBytesOf(name)).toBe(LIMIT);
  });

  it("fills max_bytes for the queue stream", async () => {
    const stream = track(`MB_QUEUE_${run}`);
    await provision({ stream, prefix: `mbq${run}` });
    expect(await maxBytesOf(stream)).toBe(LIMIT);
  });

  it("fills max_bytes for the cron stream", async () => {
    const stream = track(`MB_CRON_${run}`);
    const cron = createCronRuntime({ stream, prefix: `mbc${run}` });
    await cron.trigger("tick");
    expect(await maxBytesOf(stream)).toBe(LIMIT);
  });

  it("fills max_bytes for key value buckets and honours the option", async () => {
    await openKv(`mbkv_${run}`);
    track(`KV_mbkv_${run}`);
    expect(await maxBytesOf(`KV_mbkv_${run}`)).toBe(LIMIT);
    await openKv(`mbkvx_${run}`, { maxBytes: 3 * MIB });
    track(`KV_mbkvx_${run}`);
    expect(await maxBytesOf(`KV_mbkvx_${run}`)).toBe(3 * MIB);
  });

  it("fills max_bytes for object stores and honours the option", async () => {
    await openObj(`mbobj_${run}`);
    track(`OBJ_mbobj_${run}`);
    expect(await maxBytesOf(`OBJ_mbobj_${run}`)).toBe(LIMIT);
    await openObj(`mbobjx_${run}`, { maxBytes: 3 * MIB });
    track(`OBJ_mbobjx_${run}`);
    expect(await maxBytesOf(`OBJ_mbobjx_${run}`)).toBe(3 * MIB);
  });

  it("fills max_bytes for the blob object store", async () => {
    const bucket = `mbblob_${run}`;
    configureBlob({ bucket, baseUrl: "http://localhost:3000/blob", secret: "test-secret" });
    await getBlobStore();
    track(`OBJ_${bucket}`);
    expect(await maxBytesOf(`OBJ_${bucket}`)).toBe(LIMIT);
  });
});
