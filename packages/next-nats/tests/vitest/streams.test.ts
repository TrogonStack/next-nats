import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import { ProvisionMode, defineStream, ensureStream, ensureStreamOnce, provisionMode, streamDrift, toStreamConfig, untilStreamExists } from "../../src/streams.js";

const run = Math.random().toString(36).slice(2, 8);
const created: string[] = [];
const name = (suffix: string) => {
  const n = `S${suffix}_${run}`;
  created.push(n);
  return n;
};

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_URL, name: "next-nats-streams-test" });
});

afterAll(async () => {
  const { jsm } = await getNats();
  for (const n of created) await jsm.streams.delete(n).catch(() => undefined);
  await closeNats();
});

describe("toStreamConfig", () => {
  it("converts durations to nanoseconds and maps friendly fields", () => {
    const config = toStreamConfig({
      name: "ORDERS",
      subjects: ["orders.>"],
      maxAge: "24h",
      duplicateWindow: "90s",
      replicas: 3,
      maxBytes: 1024,
      retention: "workqueue",
      storage: "memory",
      placement: { cluster: "c1", tags: ["ssd"] },
    });
    expect(config).toEqual({
      name: "ORDERS",
      subjects: ["orders.>"],
      max_age: 86_400_000_000_000,
      duplicate_window: 90_000_000_000,
      num_replicas: 3,
      max_bytes: 1024,
      retention: "workqueue",
      storage: "memory",
      placement: { cluster: "c1", tags: ["ssd"] },
    });
  });

  it("keeps the raw snake case fields working", () => {
    expect(toStreamConfig({ name: "A", max_age: 5, num_replicas: 2 })).toEqual({ name: "A", max_age: 5, num_replicas: 2 });
  });

  it("rejects bad input", () => {
    expect(() => toStreamConfig({ name: "bad.name" })).toThrow();
    expect(() => toStreamConfig({ name: "A", maxAge: "soon" })).toThrow(/Invalid duration/);
    expect(() => toStreamConfig({ name: "A", replicas: 0 })).toThrow(/replicas/);
    expect(() => toStreamConfig({ name: "A", subjects: ["a b"] })).toThrow();
  });
});

describe("streamDrift", () => {
  it("ignores subject order and unset fields, reports differences", () => {
    const current = { name: "A", subjects: ["b", "a"], max_age: 1, placement: { tags: ["x"], cluster: "c" } };
    expect(streamDrift(current, { name: "A", subjects: ["a", "b"] })).toEqual([]);
    expect(streamDrift(current, { name: "A", placement: { cluster: "c", tags: ["x"] } })).toEqual([]);
    expect(streamDrift(current, { name: "A", max_age: 2, subjects: ["a"] }).sort()).toEqual(["max_age", "subjects"]);
  });
});

describe("provision mode", () => {
  it("validates values", () => {
    expect(provisionMode("never")).toBe(ProvisionMode.Never);
    expect(provisionMode("startup")).toBe("startup");
    expect(provisionMode("update")).toBe("update");
    expect(() => provisionMode("sometimes")).toThrow(/provision mode/);
    expect(() => defineStream({ name: "A" }, { provision: "x" as never })).toThrow();
  });

  it("defaults to startup", () => {
    expect(defineStream({ name: "A" }).provision).toBe("startup");
  });
});

describe("ensureStream", () => {
  it("creates then updates the stream to match", async () => {
    const n = name("ENS");
    const { jsm } = await getNats();
    const created1 = await ensureStream({ name: n, subjects: [`ens.${run}.>`], maxAge: "1h" });
    expect(created1.config.max_age).toBe(3_600_000_000_000);

    const updated = await ensureStream({ name: n, subjects: [`ens.${run}.>`, `ens2.${run}`], maxAge: "2h", duplicateWindow: "30s" });
    expect(updated.config.max_age).toBe(7_200_000_000_000);
    expect(updated.config.duplicate_window).toBe(30_000_000_000);
    expect([...updated.config.subjects].sort()).toEqual([`ens.${run}.>`, `ens2.${run}`].sort());
    expect((await jsm.streams.info(n)).config.max_age).toBe(7_200_000_000_000);
  });

  it("is a no-op when nothing changed", async () => {
    const n = name("NOOP");
    const first = await ensureStream({ name: n, subjects: [`noop.${run}`], maxAge: "1h" });
    const again = await ensureStream({ name: n, subjects: [`noop.${run}`], maxAge: "1h" });
    expect(again.created).toEqual(first.created);
    expect(again.config.max_age).toBe(first.config.max_age);
  });
});

describe("defineStream", () => {
  it("never: fails when missing, returns the stream when present", async () => {
    const n = name("NEVER");
    const def = defineStream({ name: n, subjects: [`never.${run}`] }, { provision: "never" });
    await expect(def.ensure()).rejects.toThrow(/does not exist/);
    const { jsm } = await getNats();
    await jsm.streams.add({ name: n, subjects: [`never.${run}`] });
    expect((await def.ensure()).config.name).toBe(n);
  });

  it("startup: creates when missing and leaves an existing stream alone", async () => {
    const n = name("START");
    const def = defineStream({ name: n, subjects: [`start.${run}`], maxAge: "1h" }, { provision: "startup" });
    expect((await def.ensure()).config.max_age).toBe(3_600_000_000_000);
    const changed = defineStream({ name: n, subjects: [`start.${run}`], maxAge: "5h" }, { provision: "startup" });
    expect((await changed.ensure()).config.max_age).toBe(3_600_000_000_000);
  });

  it("update: creates, then reconciles", async () => {
    const n = name("UPD");
    await defineStream({ name: n, subjects: [`upd.${run}`], maxAge: "1h" }, { provision: "update" }).ensure();
    const info = await defineStream({ name: n, subjects: [`upd.${run}`], maxAge: "5h" }, { provision: "update" }).ensure();
    expect(info.config.max_age).toBe(18_000_000_000_000);
  });
});

describe("ensureStreamOnce", () => {
  it("provisions on the first call and reuses the result", async () => {
    const n = name("ONCE");
    const ensure = ensureStreamOnce({ name: n, subjects: [`once.${run}`] });
    const { jsm } = await getNats();
    await expect(jsm.streams.info(n)).rejects.toThrow();
    const first = await ensure();
    expect(await ensure()).toBe(first);
  });
});

describe("untilStreamExists", () => {
  it("returns at once when the stream exists", async () => {
    const n = name("PRESENT");
    await ensureStream({ name: n, subjects: [`present.${run}`] });
    await untilStreamExists(n, { subjects: [`present.${run}`] });
  });

  it("wakes when a message arrives on its subjects and the stream exists by then", async () => {
    const n = name("WAKE");
    const waiting = untilStreamExists(n, { subjects: [`wake.${run}.>`], pollMs: 60_000 });
    let resolved = false;
    void waiting.then(() => (resolved = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(resolved).toBe(false);
    await ensureStream({ name: n, subjects: [`wake.${run}.>`] });
    const { js } = await getNats();
    await js.publish(`wake.${run}.a`, "x");
    await waiting;
    expect(resolved).toBe(true);
  });

  it("finds a stream created without any traffic on the next poll", async () => {
    const n = name("POLL");
    const waiting = untilStreamExists(n, { pollMs: 200 });
    await ensureStream({ name: n, subjects: [`poll.${run}`] });
    await waiting;
  });

  it("stops waiting when aborted", async () => {
    const controller = new AbortController();
    const waiting = untilStreamExists(name("ABORT"), { pollMs: 60_000, signal: controller.signal });
    controller.abort();
    await waiting;
  });
});
