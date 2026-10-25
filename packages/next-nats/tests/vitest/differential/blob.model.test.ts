import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, transcript, type Harness, type Scenario } from "./blob-harness.js";

type Operation =
  | { kind: "put"; pathname: string; body: string; allowOverwrite: boolean }
  | { kind: "del"; pathname: string }
  | { kind: "copy"; from: string; to: string; allowOverwrite: boolean }
  | { kind: "head"; pathname: string }
  | { kind: "list"; prefix: string | undefined; limit: number | undefined; mode: "expanded" | "folded" };

const pathnames = ["a.txt", "b.txt", "d/c.txt", "d/e/f.txt", "d/g.bin"];
const prefixes = [undefined, "d/", "d/e/", "a", "zz/"];

const pathname = fc.constantFrom(...pathnames);

const operation: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({
    kind: fc.constant("put" as const),
    pathname,
    body: fc.string({ maxLength: 24 }).filter((value) => value.length > 0),
    allowOverwrite: fc.boolean(),
  }),
  fc.record({ kind: fc.constant("del" as const), pathname }),
  fc.record({ kind: fc.constant("copy" as const), from: pathname, to: pathname, allowOverwrite: fc.boolean() }),
  fc.record({ kind: fc.constant("head" as const), pathname }),
  fc.record({
    kind: fc.constant("list" as const),
    prefix: fc.constantFrom(...prefixes),
    limit: fc.constantFrom(undefined, 1, 2, 3, 100),
    mode: fc.constantFrom("expanded" as const, "folded" as const),
  }),
);

function scenarioOf(operations: Operation[]): Scenario {
  return {
    name: "model",
    async run(ctx) {
      const access = "public" as const;
      let step = 0;
      for (const op of operations) {
        const label = `${step++}:${op.kind}`;
        switch (op.kind) {
          case "put":
            await ctx.attempt(label, () => ctx.api.put(op.pathname, op.body, { access, allowOverwrite: op.allowOverwrite }));
            break;
          case "del":
            await ctx.attempt(label, () => ctx.api.del(op.pathname));
            break;
          case "copy":
            await ctx.attempt(label, () => ctx.api.copy(op.from, op.to, { access, allowOverwrite: op.allowOverwrite }));
            break;
          case "head":
            await ctx.attempt(label, () => ctx.api.head(op.pathname));
            break;
          case "list":
            await ctx.attempt(label, () =>
              ctx.api.list({ prefix: op.prefix, limit: op.limit, mode: op.mode }).then((page) => ({
                blobs: page.blobs.map((blob) => ({ pathname: blob.pathname, size: blob.size, etag: blob.etag })),
                folders: "folders" in page ? page.folders : undefined,
                hasMore: page.hasMore,
              })),
            );
            break;
        }
      }
      await ctx.attempt("final", () =>
        ctx.api.list().then((page) => page.blobs.map((blob) => ({ pathname: blob.pathname, size: blob.size, etag: blob.etag }))),
      );
    },
  };
}

const seed = Number(process.env.BLOB_MODEL_SEED ?? 20260101);
const numRuns = Number(process.env.BLOB_MODEL_RUNS ?? 100);

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  await harness.close();
});

describe("blob model: put, del, copy, head and list sequences", () => {
  it(`ours equals @vercel/blob over generated sequences (seed ${seed})`, { timeout: 300_000 }, async () => {
    console.info(`blob model seed=${seed} runs=${numRuns}`);
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 14 }), async (operations) => {
        const scenario = scenarioOf(operations);
        const real = await transcript(harness.real, scenario);
        const ours = await transcript(harness.ours, scenario);
        expect(ours).toEqual(real);
      }),
      { seed, numRuns },
    );
  });
});
