import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };

const root = fileURLToPath(new URL("../..", import.meta.url));
const NAME = "@trogonstack/next-nats";
const BUDGET = 16 * 1024;

type Subpath = keyof typeof pkg.exports;

const sourceOf = (subpath: Subpath): string => {
  const target = pkg.exports[subpath];
  if (typeof target === "string") throw new Error(`${subpath} has no module entry`);
  return `${root}/${target.default.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")}`;
};

async function bundleSize(subpath: Subpath, name: string, client = false): Promise<number> {
  const result = await build({
    stdin: { contents: `import { ${name} as x } from "${NAME}${subpath.slice(1)}"; globalThis.__x = x;`, resolveDir: root },
    bundle: true,
    write: false,
    minify: true,
    format: "esm",
    platform: client ? "browser" : "node",
    conditions: client ? [] : ["react-server"],
    external: ["next", "next/*", "react", "react-dom"],
    logLevel: "silent",
    plugins: [
      {
        name: "self",
        setup(b) {
          b.onResolve({ filter: /^@trogonstack\/next-nats/ }, (args) => ({
            path: sourceOf(`.${args.path.slice(NAME.length)}` as Subpath),
          }));
        },
      },
    ],
  });
  return result.outputFiles[0]!.contents.length;
}

// TODO: the @nats-io/* packages do not declare "sideEffects", so any module that reaches them
// keeps the whole client (about 145K minified). Upstream a "sideEffects": false to nats.js and
// tighten these budgets for NATS-backed exports once it lands.
describe("tree-shaking", () => {
  it.each<[Subpath, string]>([
    [".", "ByteSize"],
    ["./kv", "KvError"],
    ["./kv", "encodeKey"],
    ["./redis", "UnsupportedCommandError"],
    ["./blob", "BlobAccessError"],
    ["./queue", "BadRequestError"],
    ["./edge-config", "EdgeConfigError"],
    ["./cache", "CACHE_ENV"],
    ["./ratelimit", "Analytics"],
    ["./services", "EndpointError"],
    ["./cron", "VERCEL_CRON_USER_AGENT"],
    ["./health", "DEFAULT_READINESS_GRACE_MS"],
    ["./agents", "agentName"],
    ["./edge", "Secret"],
    ["./edge", "EdgeRequestError"],
    ["./edge", "edgeNatsConfig"],
    ["./next", "INCREMENTAL_HANDLER_PATH"],
  ])("%s { %s } leaves the NATS client out of the bundle", async (subpath, name) => {
    expect(await bundleSize(subpath, name)).toBeLessThan(BUDGET);
  });

  it("./blob/client stays free of NATS for the browser", async () => {
    expect(await bundleSize("./blob/client", "EventTypes", true)).toBeLessThan(BUDGET);
  });
});
