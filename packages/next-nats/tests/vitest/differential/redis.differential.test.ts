import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commandArb, normalize, pipelineArb, reconcileSdkDefects, stripWireSuffix } from "./redis-commands.js";
import type { PipelineCall } from "./redis-commands.js";
import { invoke, openPair, requireProxy, settle } from "./redis-harness.js";
import type { Call, Outcome, Pair } from "./redis-harness.js";

const available = await requireProxy();
const SEED = Number(process.env.NEXT_NATS_PARITY_SEED ?? 20_261_025);
const PROPERTY_TIMEOUT_MS = 600_000;
const RUNS = Number(process.env.NEXT_NATS_PARITY_RUNS ?? 60);

type Step = Call | PipelineCall;

function normalizeOutcome(step: Step, outcome: Outcome): unknown {
  if (!outcome.ok) return { error: outcome.name, message: stripWireSuffix(outcome.message) };
  if (step.name !== "@pipeline") return { value: normalize(step.name, outcome.value) };
  const p = step as PipelineCall;
  const results = outcome.value as unknown[];
  return {
    value: results.map((r, i) => {
      const name = p.commands[i]?.name ?? "";
      if (p.keepErrors) {
        const entry = r as { result: unknown; error?: string };
        return entry.error === undefined ? { result: normalize(name, entry.result) } : { error: entry.error };
      }
      return normalize(name, r);
    }),
  };
}

async function execute(client: Pair["real"] | Pair["ours"], step: Step): Promise<Outcome> {
  if (step.name !== "@pipeline") return settle(() => invoke(client, step as Call));
  const p = step as PipelineCall;
  return settle(async () => {
    const builder = (p.atomic ? client.multi() : client.pipeline()) as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const command of p.commands) {
      const queue = builder[command.name] as (...a: unknown[]) => unknown;
      queue.apply(builder, command.args);
    }
    const exec = (builder as unknown as { exec: (o?: unknown) => Promise<unknown> }).exec;
    return exec.call(builder, p.keepErrors ? { keepErrors: true } : undefined);
  });
}

function isProxyMultiExecDefect(step: Step, real: Outcome): boolean {
  return step.name === "@pipeline" && (step as PipelineCall).atomic && !real.ok && real.name === "UpstashJSONParseError";
}

async function replay(pair: Pair, steps: Step[]): Promise<void> {
  await pair.reset();
  for (const [index, step] of steps.entries()) {
    const realOutcome = await execute(pair.real, step);
    if (isProxyMultiExecDefect(step, realOutcome)) return;
    const oursOutcome = await execute(pair.ours, step);
    const expected = reconcileSdkDefects(step, realOutcome, oursOutcome);
    expect(normalizeOutcome(step, oursOutcome), `step ${index}: ${JSON.stringify(step)}`).toEqual(
      normalizeOutcome(step, expected),
    );
  }
}

describe.skipIf(!available)("redis differential against @upstash/redis", () => {
  for (const [automaticDeserialization, enableAutoPipelining] of [[true, true], [false, true], [true, false], [false, false]] as const) {
    describe(`automaticDeserialization ${automaticDeserialization}, enableAutoPipelining ${enableAutoPipelining}`, () => {
      let pair: Pair;
      beforeAll(async () => {
        pair = await openPair({ automaticDeserialization, enableAutoPipelining });
      });
      afterAll(async () => {
        await pair.close();
      });

      it("matches on generated command sequences", async () => {
        await fc.assert(
          fc.asyncProperty(fc.array(commandArb(), { minLength: 1, maxLength: 30 }), (steps) => replay(pair, steps)),
          { seed: SEED, numRuns: RUNS, endOnFailure: false },
        );
      }, PROPERTY_TIMEOUT_MS);

      it("matches on generated pipelines and transactions", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.array(fc.oneof({ weight: 3, arbitrary: commandArb() }, { weight: 1, arbitrary: pipelineArb() }), {
              minLength: 1,
              maxLength: 12,
            }),
            (steps) => replay(pair, steps),
          ),
          { seed: SEED + 1, numRuns: RUNS, endOnFailure: false },
        );
      }, PROPERTY_TIMEOUT_MS);
    });
  }
});
