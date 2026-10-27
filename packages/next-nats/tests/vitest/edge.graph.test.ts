import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../../src/edge/index.ts");
const require = createRequire(import.meta.url);

const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function specifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(IMPORT)].map((m) => (m[1] ?? m[2])!);
}

function walk(file: string, files: Set<string>, externals: Set<string>): void {
  if (files.has(file)) return;
  files.add(file);
  for (const spec of specifiers(file)) {
    if (spec.startsWith(".")) {
      const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (existsSync(target)) walk(target, files, externals);
    } else {
      externals.add(spec);
    }
  }
}

describe("edge module graph", () => {
  const files = new Set<string>();
  const externals = new Set<string>();
  walk(entry, files, externals);

  it("reaches the shared pure modules", () => {
    const names = [...files].map((f) => f.slice(resolve(here, "../../src").length + 1));
    expect(names).toEqual(expect.arrayContaining(["edge/connection.ts", "edge/kv.ts", "edge/request.ts", "edge/subscribe.ts", "publish-core.ts", "trace.ts", "auth.ts"]));
  });

  it("never reaches connection.ts, publish.ts or config.ts of the node entry", () => {
    const names = [...files].map((f) => f.slice(resolve(here, "../../src").length + 1));
    for (const forbidden of ["connection.ts", "publish.ts", "config.ts", "instrumentation.ts"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("imports no node: builtin and no server-only", () => {
    const offenders = [...externals].filter((s) => s.startsWith("node:") || s === "server-only");
    expect(offenders).toEqual([]);
  });

  it("does not import transport-node", () => {
    expect([...externals].filter((s) => s.startsWith("@nats-io/transport-node"))).toEqual([]);
  });

  it("only depends on the NATS client packages", () => {
    expect([...externals].sort()).toEqual(["@nats-io/jetstream", "@nats-io/kv", "@nats-io/nats-core"]);
  });

  it("keeps the NATS client packages free of node: imports", () => {
    for (const name of ["@nats-io/nats-core", "@nats-io/jetstream", "@nats-io/kv"]) {
      const pkgEntry = require.resolve(name);
      const pkgFiles = new Set<string>();
      const stack = [pkgEntry];
      while (stack.length > 0) {
        const file = stack.pop()!;
        if (pkgFiles.has(file)) continue;
        pkgFiles.add(file);
        for (const spec of specifiers(file)) {
          if (spec.startsWith(".")) {
            const target = resolve(dirname(file), spec);
            if (existsSync(target)) stack.push(target);
          } else {
            expect(spec.startsWith("node:"), `${name}: ${file} imports ${spec}`).toBe(false);
            if (spec.startsWith("@nats-io/") && spec !== name) stack.push(createRequire(file).resolve(spec));
          }
        }
      }
    }
  });
});
