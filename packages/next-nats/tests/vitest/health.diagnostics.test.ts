import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeNats, configureNats, connectNats } from "../../src/connection.js";
import { registerDiagnostics } from "../../src/diagnostics.js";
import { createDiagnosticsHandler } from "../../src/health/index.js";
import { GET as mountedGET } from "../../src/health/diagnostics.js";
import { dockerAvailable, startNatsContainer, type NatsContainer } from "../support/nats-container.js";

const SERVERS = process.env.NATS_URL!;
const available = dockerAvailable();

afterEach(async () => {
  await closeNats();
});

const json = async (response: Response) => (await response.json()) as Record<string, any>;

describe("before connecting", () => {
  it("answers 503 with no-store and does not open a connection", async () => {
    configureNats({ servers: SERVERS });
    const response = await createDiagnosticsHandler()();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await json(response)).toMatchObject({ connected: false, status: "idle", auth: { mode: "none" }, rttMs: null, jetstream: null });
  });

  it.each([
    ["creds", { kind: "creds", creds: "SECRET-CREDS" }],
    ["credsFile", { kind: "credsFile", path: "/secret/path.creds" }],
    ["jwt", { kind: "jwt", userJwt: "SECRET-JWT", seed: "SECRET-SEED" }],
    ["bearer", { kind: "bearer", userJwt: "SECRET-JWT" }],
    ["nkey", { kind: "nkey", seed: "SECRET-SEED" }],
    ["nkeyFile", { kind: "nkeyFile", path: "/secret/seed.nk" }],
    ["token", { kind: "token", token: "SECRET-TOKEN" }],
    ["userpass", { kind: "userpass", user: "SECRET-USER", pass: "SECRET-PASS" }],
    ["none", { kind: "none" }],
  ] as const)("reports auth mode %s without identities or secrets", async (mode, auth) => {
    configureNats({ servers: SERVERS, auth });
    const text = await (await createDiagnosticsHandler()()).text();
    expect(JSON.parse(text).auth).toEqual({ mode });
    expect(text).not.toMatch(/SECRET|path\.creds|seed\.nk/);
  });
});

describe("connected", () => {
  beforeAll(() => registerDiagnostics("test-section", () => ({ hello: "world" })));

  it("reports connection, rtt, jetstream stats and registered sections with 200", async () => {
    const { nc } = await connectNats({ servers: SERVERS });
    const response = await createDiagnosticsHandler()();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await json(response);
    expect(body).toMatchObject({ connected: true, status: "connected", auth: { mode: "none" } });
    expect(body.server).toBe(nc.getServer());
    expect(typeof body.rttMs).toBe("number");
    expect(body.jetstream).toMatchObject({ available: true });
    for (const key of ["streams", "consumers", "memory", "storage"]) expect(typeof body.jetstream[key]).toBe("number");
    expect(body.diagnostics["test-section"]).toEqual({ hello: "world" });
  });

  it("serves the same body from the mountable GET", async () => {
    await connectNats({ servers: SERVERS });
    const response = await mountedGET();
    expect(response.status).toBe(200);
    expect((await json(response)).connected).toBe(true);
  });

  it("goes back to 503 once the connection closes", async () => {
    await connectNats({ servers: SERVERS });
    await closeNats();
    expect((await createDiagnosticsHandler()()).status).toBe(503);
  });

  it("isolates a failing section", async () => {
    const off = registerDiagnostics("broken", () => {
      throw new Error("nope");
    });
    await connectNats({ servers: SERVERS });
    const body = await json(await createDiagnosticsHandler()());
    expect(body.diagnostics.broken).toEqual({ error: "unavailable" });
    off();
  });
});

describe.skipIf(!available)("account without JetStream", () => {
  let container: NatsContainer;
  beforeAll(async () => {
    container = await startNatsContainer("port: 4222\n", [4222]);
  });
  afterAll(() => container?.stop());

  it("reports jetstream.available false", async () => {
    await connectNats({ servers: `nats://127.0.0.1:${container.port(4222)}` });
    const response = await createDiagnosticsHandler()();
    expect(response.status).toBe(200);
    expect((await json(response)).jetstream).toEqual({ available: false });
  });
});
