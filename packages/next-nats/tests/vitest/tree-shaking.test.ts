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

  // Since nats.js 3.5.0 the @nats-io/* packages tree-shake, so a NATS-backed export only keeps the
  // client pieces it reaches. Budgets sit about 10% above the measured size and well below the
  // whole-package size, so a regression to keeping every @nats-io module fails here.
  it.each<[Subpath, string, number]>([
    ["./edge", "getEdgeNats", 192],
    ["./edge", "corePublish", 196],
    ["./edge", "edgeRequest", 198],
    ["./edge", "edgeSubscribe", 194],
    ["./edge", "jsPublish", 198],
    ["./edge", "edgeKv", 212],
    ["./kv", "KvStore", 230],
    ["./kv", "kv", 261],
    ["./redis", "Redis", 261],
    ["./queue", "send", 224],
    ["./blob", "put", 254],
    ["./ratelimit", "Ratelimit", 269],
  ])("%s { %s } stays under %iK", async (subpath, name, kib) => {
    expect(await bundleSize(subpath, name)).toBeLessThan(kib * 1024);
  });

  it("./blob/client stays free of NATS for the browser", async () => {
    expect(await bundleSize("./blob/client", "EventTypes", true)).toBeLessThan(BUDGET);
  });
});
