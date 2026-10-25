import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import { corePublish, jsPublish } from "../../src/publish.js";
import { ensureStream } from "../../src/streams.js";
import { createSseResponse, formatSseEvent } from "../../src/realtime/sse.js";
import { consoleLogger, setLogger, silentLogger } from "../../src/logger.js";
import { sseFromStream, sseFromSubject } from "../../src/realtime/index.js";

const run = Math.random().toString(36).slice(2, 8);
const STREAM = `RT_${run}`;
const SUBJ = `rt.${run}`;

interface Parsed {
  id?: string;
  event?: string;
  data?: string;
}

function parseChunk(chunk: string): Parsed[] {
  const out: Parsed[] = [];
  for (const block of chunk.split("\n\n")) {
    if (!block.trim() || block.split("\n").every((l) => l.startsWith(":") || l.startsWith("retry:"))) continue;
    const ev: Parsed = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) ev.id = line.slice(4);
      else if (line.startsWith("event: ")) ev.event = line.slice(7);
      else if (line.startsWith("data: ")) ev.data = (ev.data === undefined ? "" : `${ev.data}\n`) + line.slice(6);
    }
    out.push(ev);
  }
  return out;
}

async function readEvents(res: Response, count: number, ms = 10_000): Promise<Parsed[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Parsed[] = [];
  let buffer = "";
  const deadline = Date.now() + ms;
  while (events.length < count) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timeout with ${events.length}/${count} events`);
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("read timeout")), left)),
    ]);
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const cut = buffer.lastIndexOf("\n\n");
    if (cut >= 0) {
      events.push(...parseChunk(buffer.slice(0, cut + 2)));
      buffer = buffer.slice(cut + 2);
    }
  }
  reader.releaseLock();
  return events;
}

async function consumerCount(): Promise<number> {
  const { jsm } = await getNats();
  let n = 0;
  for await (const _ of jsm.consumers.list(STREAM)) n += 1;
  return n;
}

async function waitFor(fn: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const req = (signal?: AbortSignal, init: RequestInit = {}) =>
  new Request("http://localhost/api/feed", { signal, ...init });

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_SERVERS, workers: true, name: "next-nats-realtime-test" });
  await ensureStream({ name: STREAM, subjects: [`${SUBJ}.>`] });
});

afterAll(async () => {
  const { jsm } = await getNats();
  await jsm.streams.delete(STREAM).catch(() => undefined);
  await closeNats();
});

describe("sse formatting", () => {
  it("splits multi-line data and strips newlines from fields", () => {
    expect(formatSseEvent({ id: 7, event: "a\nb", data: "x\ny" })).toBe("event: a b\nid: 7\ndata: x\ndata: y\n\n");
  });
});

describe("sseFromStream", () => {
  it("streams events with stream sequence ids and the right headers", async () => {
    await jsPublish(`${SUBJ}.a`, { n: 1 });
    await jsPublish(`${SUBJ}.a`, { n: 2 });
    const ac = new AbortController();
    const res = await sseFromStream(req(ac.signal), { stream: STREAM, filterSubjects: [`${SUBJ}.>`], deliver: "all" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readEvents(res, 2);
    expect(events.map((e) => JSON.parse(e.data!))).toEqual([{ n: 1 }, { n: 2 }]);
    expect(events.every((e) => /^\d+$/.test(e.id!))).toBe(true);
    ac.abort();
  });

  it("delivers only new messages by default", async () => {
    const ac = new AbortController();
    const res = await sseFromStream(req(ac.signal), { stream: STREAM });
    await jsPublish(`${SUBJ}.live`, { live: true });
    const [event] = await readEvents(res, 1);
    expect(JSON.parse(event!.data!)).toEqual({ live: true });
    ac.abort();
  });

  it("resumes after Last-Event-ID without replaying or skipping", async () => {
    const first = new AbortController();
    const res1 = await sseFromStream(req(first.signal), { stream: STREAM, filterSubjects: [`${SUBJ}.r.>`], deliver: "new" });
    for (let n = 1; n <= 3; n++) await jsPublish(`${SUBJ}.r.x`, { n });
    const seen = await readEvents(res1, 2);
    first.abort();

    const second = new AbortController();
    const res2 = await sseFromStream(
      req(second.signal, { headers: { "last-event-id": seen[1]!.id! } }),
      { stream: STREAM, filterSubjects: [`${SUBJ}.r.>`], deliver: "new" },
    );
    await jsPublish(`${SUBJ}.r.x`, { n: 4 });
    const rest = await readEvents(res2, 2);
    expect(rest.map((e) => JSON.parse(e.data!).n)).toEqual([3, 4]);
    second.abort();
  });

  it("accepts the lastEventId query parameter", async () => {
    const ack = await jsPublish(`${SUBJ}.q.x`, { n: 1 });
    await jsPublish(`${SUBJ}.q.x`, { n: 2 });
    const ac = new AbortController();
    const res = await sseFromStream(
      new Request(`http://localhost/api/feed?lastEventId=${ack.seq}`, { signal: ac.signal }),
      { stream: STREAM, filterSubjects: [`${SUBJ}.q.>`] },
    );
    const [event] = await readEvents(res, 1);
    expect(JSON.parse(event!.data!)).toEqual({ n: 2 });
    ac.abort();
  });

  it("applies filter and transform", async () => {
    const ac = new AbortController();
    const res = await sseFromStream<{ n: number }>(req(ac.signal), {
      stream: STREAM,
      filterSubjects: [`${SUBJ}.t.>`],
      filter: (m) => m.data.n % 2 === 0,
      transform: (m) => ({ event: "even", data: { doubled: m.data.n * 2 } }),
    });
    for (let n = 1; n <= 4; n++) await jsPublish(`${SUBJ}.t.x`, { n });
    const events = await readEvents(res, 2);
    expect(events.map((e) => e.event)).toEqual(["even", "even"]);
    expect(events.map((e) => JSON.parse(e.data!).doubled)).toEqual([4, 8]);
    expect(events.every((e) => /^\d+$/.test(e.id!))).toBe(true);
    ac.abort();
  });

  it("emits heartbeat comments", async () => {
    const ac = new AbortController();
    const res = await sseFromStream(req(ac.signal), { stream: STREAM, filterSubjects: [`${SUBJ}.hb.>`], heartbeat: 50 });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const end = Date.now() + 5_000;
    while (!text.includes(": heartbeat") && Date.now() < end) {
      text += decoder.decode((await reader.read()).value);
    }
    expect(text).toContain(": heartbeat");
    ac.abort();
  });

  it("removes the ephemeral consumer on abort and on cancel", async () => {
    const baseline = await consumerCount();

    const ac = new AbortController();
    const res = await sseFromStream(req(ac.signal), { stream: STREAM });
    expect(await consumerCount()).toBe(baseline + 1);
    await readEvents(res, 0);
    ac.abort();
    await waitFor(async () => (await consumerCount()) === baseline);

    const res2 = await sseFromStream(req(), { stream: STREAM });
    expect(await consumerCount()).toBe(baseline + 1);
    await res2.body!.cancel();
    await waitFor(async () => (await consumerCount()) === baseline);
  });

  it("does not leak a consumer when the request is already aborted", async () => {
    const baseline = await consumerCount();
    const ac = new AbortController();
    ac.abort();
    await sseFromStream(req(ac.signal), { stream: STREAM });
    await waitFor(async () => (await consumerCount()) === baseline);
  });

  it("rejects when the stream does not exist", async () => {
    await expect(sseFromStream(req(), { stream: `MISSING_${run}` })).rejects.toThrow();
  });
});

describe("sseFromSubject", () => {
  it("relays core messages, honors wildcards and unsubscribes on abort", async () => {
    const { nc } = await getNats();
    const ac = new AbortController();
    const res = await sseFromSubject(req(ac.signal), `core.${run}.*`, { event: "msg" });
    await nc.flush();
    await corePublish(`core.${run}.a`, { hello: "a" });
    await corePublish(`core.${run}.b`, "plain");
    const events = await readEvents(res, 2);
    expect(events.map((e) => e.event)).toEqual(["msg", "msg"]);
    expect(events.map((e) => e.data)).toEqual(['{"hello":"a"}', "plain"]);
    ac.abort();
    await waitFor(async () => (await nc.rtt(), true));
  });
});

describe("sink.fail", () => {
  it("sends a generic nats-error and keeps the detail in the logger", async () => {
    const logged: unknown[] = [];
    setLogger({ ...silentLogger, error: (_message, context) => void logged.push(context?.error) });
    try {
      const res = createSseResponse(req(), { heartbeat: 0 }, (sink) => {
        sink.fail(new Error("connect ECONNREFUSED 10.0.0.7:4222"));
      });
      const text = await res.text();
      expect(text).toContain("event: nats-error");
      expect(text).toContain("UNAVAILABLE");
      expect(text).not.toContain("ECONNREFUSED");
      expect(text).not.toContain("10.0.0.7");
      expect(logged).toHaveLength(1);
    } finally {
      setLogger(consoleLogger());
    }
  });
});
