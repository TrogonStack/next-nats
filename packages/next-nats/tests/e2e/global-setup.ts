import { readFile, rm, writeFile } from "node:fs/promises";
import { buildDemo } from "./support/build.js";
import { BUILD_ROOT, BUILD_VARIANTS, DEMO_ROOT } from "./support/env.js";

const TSCONFIG = `${DEMO_ROOT}/tsconfig.json`;

export default async function setup(): Promise<() => Promise<void>> {
  const tsconfig = await readFile(TSCONFIG, "utf8");
  if (process.env.E2E_SKIP_BUILD !== "1") {
    await rm(`${DEMO_ROOT}/${BUILD_ROOT}`, { recursive: true, force: true });
    for (const variant of BUILD_VARIANTS) await buildDemo(variant);
    await writeFile(TSCONFIG, tsconfig);
  }
  return async () => {
    await writeFile(TSCONFIG, tsconfig);
    if (process.env.E2E_KEEP_BUILDS !== "1" && process.env.E2E_SKIP_BUILD !== "1") {
      await rm(`${DEMO_ROOT}/${BUILD_ROOT}`, { recursive: true, force: true });
    }
  };
}
