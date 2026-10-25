import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const VERCEL_JSON_ENV = "NEXT_NATS_VERCEL_JSON";

export function embeddedVercelJson(): string | undefined {
  const raw = process.env.NEXT_NATS_VERCEL_JSON;
  return raw === undefined || raw === "" ? undefined : raw;
}

export function readVercelJsonFile(file: string): string | undefined {
  const absolute = resolve(/* turbopackIgnore: true */ file);
  return existsSync(/* turbopackIgnore: true */ absolute) ? readFileSync(/* turbopackIgnore: true */ absolute, "utf8") : undefined;
}

export function loadVercelJsonText(explicitPath?: string): string | undefined {
  if (explicitPath === undefined) {
    const embedded = embeddedVercelJson();
    if (embedded !== undefined) return embedded;
  }
  return readVercelJsonFile(resolve(/* turbopackIgnore: true */ process.cwd(), explicitPath ?? "vercel.json"));
}
