import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { distPathOf, type BuildVariant } from "./env.js";

async function* walk(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(c|m)?js$/.test(entry.name)) yield path;
  }
}

export async function bundleText(variant: BuildVariant, area: "server" | "static"): Promise<string> {
  const parts: string[] = [];
  for await (const file of walk(join(distPathOf(variant), area))) parts.push(await readFile(file, "utf8"));
  return parts.join("\n");
}

export interface ServerFilesConfig {
  cacheHandler?: string;
  cacheHandlers?: Record<string, string>;
  env?: Record<string, string>;
}

export async function requiredServerConfig(variant: BuildVariant): Promise<ServerFilesConfig> {
  const raw = await readFile(join(distPathOf(variant), "required-server-files.json"), "utf8");
  return (JSON.parse(raw) as { config: ServerFilesConfig }).config;
}
