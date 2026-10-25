import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, transcript, type Harness } from "./blob-harness.js";
import { scenarios } from "./blob-scenarios.js";

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  await harness.close();
});

describe("blob differential: @vercel/blob against the local fake, ours against NATS", () => {
  for (const scenario of scenarios) {
    it(scenario.name, { timeout: 120_000 }, async () => {
      const real = await transcript(harness.real, scenario);
      const ours = await transcript(harness.ours, scenario);
      expect(ours).toEqual(real);
    });
  }
});
