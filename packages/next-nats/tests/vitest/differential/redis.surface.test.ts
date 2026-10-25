import { Redis as UpstashRedis } from "@upstash/redis";
import { describe, expect, expectTypeOf, it } from "vitest";
import { Redis, UnsupportedCommandError } from "../../../src/redis/index.js";

const URL = "http://srh.parity.invalid";

const REDIS_ABSENT = [
  "use",
  "addTelemetry",
  "autoPipeline",
  "autoPipelineExecutor",
  "bitfield",
  "arcount",
  "ardel",
  "ardelrange",
  "arget",
  "argetrange",
  "argrep",
  "arinfo",
  "arinsert",
  "arlastitems",
  "arlen",
  "armget",
  "armset",
  "arnext",
  "arop",
  "arring",
  "arscan",
  "arseek",
  "arset",
  "bitcount",
  "bitop",
  "bitpos",
  "clientSetinfo",
  "exec",
  "geoadd",
  "geopos",
  "geodist",
  "geohash",
  "geosearch",
  "geosearchstore",
  "getbit",
  "hexpire",
  "hexpireat",
  "hexpiretime",
  "httl",
  "hpexpire",
  "hpexpireat",
  "hpexpiretime",
  "hpttl",
  "hpersist",
  "hgetex",
  "hsetex",
  "lmpop",
  "pfadd",
  "pfcount",
  "pfmerge",
  "psubscribe",
  "publish",
  "setbit",
  "subscribe",
  "xadd",
  "xack",
  "xackdel",
  "xdel",
  "xdelex",
  "xgroup",
  "xread",
  "xreadgroup",
  "xinfo",
  "xlen",
  "xpending",
  "xclaim",
  "xautoclaim",
  "xtrim",
  "xrange",
  "xrevrange",
  "readYourWritesSyncToken",
  "json",
  "functions",
  "search",
  "vector",
] as const;

const REDIS_DATA_FIELDS = ["client", "opts", "enableTelemetry", "enableAutoPipelining"] as const;

const PIPELINE_ABSENT = [
  "arcount",
  "ardel",
  "ardelrange",
  "arget",
  "argetrange",
  "argrep",
  "arinfo",
  "arinsert",
  "arlastitems",
  "arlen",
  "armget",
  "armset",
  "arnext",
  "arop",
  "arring",
  "arscan",
  "arseek",
  "arset",
  "bitcount",
  "bitfield",
  "bitop",
  "bitpos",
  "clientSetinfo",
  "geoadd",
  "geodist",
  "geopos",
  "geohash",
  "geosearch",
  "geosearchstore",
  "getbit",
  "hexpire",
  "hexpireat",
  "hexpiretime",
  "httl",
  "hpexpire",
  "hpexpireat",
  "hpexpiretime",
  "hpttl",
  "hpersist",
  "hgetex",
  "hsetex",
  "lmpop",
  "pfadd",
  "pfcount",
  "pfmerge",
  "publish",
  "setbit",
  "xadd",
  "xack",
  "xackdel",
  "xdel",
  "xdelex",
  "xgroup",
  "xread",
  "xreadgroup",
  "xinfo",
  "xlen",
  "xpending",
  "xclaim",
  "xautoclaim",
  "xtrim",
  "xrange",
  "xrevrange",
  "json",
  "functions",
  "chain",
] as const;

const PIPELINE_DATA_FIELDS = ["client", "commands", "commandOptions", "multiExec"] as const;

const THROWING = ["eval", "evalRo", "evalsha", "evalshaRo", "scriptLoad", "scriptExists", "scriptFlush", "createScript"] as const;

function memberNames(target: object): Map<string, string> {
  const members = new Map<string, string>();
  let level: object | null = target;
  while (level && level !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(level)) {
      if (members.has(name) || name.startsWith("_") || name === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(level, name)!;
      members.set(name, descriptor.get ? "getter" : typeof descriptor.value);
    }
    level = Object.getPrototypeOf(level);
  }
  return members;
}

const real = new UpstashRedis({ url: URL, token: "t", enableTelemetry: false });
const ours = new Redis({ bucket: "surface" });

function compare(realTarget: object, oursTarget: object, absent: readonly string[], dataFields: readonly string[]) {
  const realMembers = memberNames(realTarget);
  const oursMembers = memberNames(oursTarget);
  const missing = [...realMembers.keys()].filter((name) => !oursMembers.has(name));
  const allowed = new Set<string>([...absent, ...dataFields]);
  return {
    unexpectedlyMissing: missing.filter((name) => !allowed.has(name)),
    staleAllowlist: absent.filter((name) => !realMembers.has(name) || oursMembers.has(name)),
    presentOnBoth: [...realMembers].filter(([name]) => oursMembers.has(name)),
    oursMembers,
  };
}

describe("public surface parity with @upstash/redis", () => {
  it("every Redis member is implemented or on the explicit allowlist", () => {
    const result = compare(real, ours, REDIS_ABSENT, REDIS_DATA_FIELDS);
    expect(result.unexpectedlyMissing).toEqual([]);
    expect(result.staleAllowlist).toEqual([]);
  });

  it("every Pipeline member is implemented or on the explicit allowlist", () => {
    const result = compare(real.pipeline(), ours.pipeline(), PIPELINE_ABSENT, PIPELINE_DATA_FIELDS);
    expect(result.unexpectedlyMissing).toEqual([]);
    expect(result.staleAllowlist).toEqual([]);
  });

  it("members present on both sides have the same kind", () => {
    for (const [name, kind] of compare(real, ours, REDIS_ABSENT, REDIS_DATA_FIELDS).presentOnBoth) {
      const ourKind = memberNames(ours).get(name);
      expect(ourKind === kind || (kind === "getter" && ourKind === "function"), `Redis.${name}`).toBe(true);
    }
    for (const [name, kind] of compare(real.pipeline(), ours.pipeline(), PIPELINE_ABSENT, PIPELINE_DATA_FIELDS).presentOnBoth) {
      expect(memberNames(ours.pipeline()).get(name), `Pipeline.${name}`).toBe(kind);
    }
  });

  it("script commands are present and reject with UnsupportedCommandError", async () => {
    for (const name of THROWING) {
      const method = (ours as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!;
      expect(typeof method, name).toBe("function");
      const outcome = await Promise.resolve()
        .then(() => method.call(ours, "return 1", [], []))
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(outcome, name).toBeInstanceOf(UnsupportedCommandError);
    }
  });

  it("pipelined script commands fail with UnsupportedCommandError", async () => {
    for (const name of ["eval", "evalRo", "evalsha", "evalshaRo"] as const) {
      const outcome = await Promise.resolve()
        .then(async () => {
          const pipeline = ours.pipeline() as unknown as Record<string, (...a: unknown[]) => unknown> & { exec(): Promise<unknown> };
          pipeline[name]!("return 1", [], []);
          return pipeline.exec();
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(outcome, name).toBeInstanceOf(UnsupportedCommandError);
    }
  });

  it("method parameter types are assignable from the real client", () => {
    type Real = UpstashRedis;
    type Ours = Redis;
    type Mismatch = {
      [K in keyof Real & keyof Ours]: Real[K] extends (...args: infer A) => unknown
        ? Ours[K] extends (...args: A) => unknown
          ? never
          : K
        : never;
    }[keyof Real & keyof Ours];
    expectTypeOf<Mismatch>().toEqualTypeOf<"ping">();
  });
});
