import { credsAuthenticator, jwtAuthenticator, nkeyAuthenticator, tokenAuthenticator, usernamePasswordAuthenticator, type Auth, type Authenticator } from "@nats-io/nats-core";
import { invalidArgument } from "./errors.js";
import { literalFromEnv, locationFromEnv, type ReadFile } from "./location.js";
import { Secret } from "./secret.js";

type Env = Record<string, string | undefined>;

export type NatsAuth =
  | { kind: "none" }
  | { kind: "token"; token: Secret }
  | { kind: "userpass"; user: string; pass: Secret; token?: Secret }
  | { kind: "nkey"; seed: Secret; token?: Secret }
  | { kind: "nkeyFile"; path: string; token?: Secret }
  | { kind: "creds"; creds: Secret; token?: Secret }
  | { kind: "credsFile"; path: string; token?: Secret }
  | { kind: "jwt"; userJwt: Secret; seed: Secret; token?: Secret }
  | { kind: "bearer"; userJwt: Secret; token?: Secret };

export type NatsAuthInput =
  | { kind: "none" }
  | { kind: "token"; token: string | Secret }
  | { kind: "userpass"; user: string; pass: string | Secret; token?: string | Secret }
  | { kind: "nkey"; seed: string | Secret; token?: string | Secret }
  | { kind: "nkeyFile"; path: string; token?: string | Secret }
  | { kind: "creds"; creds: string | Secret; token?: string | Secret }
  | { kind: "credsFile"; path: string; token?: string | Secret }
  | { kind: "jwt"; userJwt: string | Secret; seed: string | Secret; token?: string | Secret }
  | { kind: "bearer"; userJwt: string | Secret; token?: string | Secret };

export type FileAuthKind = "credsFile" | "nkeyFile";
export type PortableAuth = Exclude<NatsAuth, { kind: FileAuthKind }>;
export type PortableAuthInput = Exclude<NatsAuthInput, { kind: FileAuthKind }>;

export function isFileAuth(auth: NatsAuth): auth is Extract<NatsAuth, { kind: FileAuthKind }> {
  return auth.kind === "credsFile" || auth.kind === "nkeyFile";
}

const optional = (token: string | Secret | undefined) => (token === undefined ? {} : { token: Secret.parse(token) });

export function normalizeAuth(auth: NatsAuthInput): NatsAuth {
  switch (auth.kind) {
    case "none":
      return auth;
    case "token":
      return { kind: "token", token: Secret.parse(auth.token) };
    case "userpass":
      return { kind: "userpass", user: auth.user, pass: Secret.parse(auth.pass), ...optional(auth.token) };
    case "nkey":
      return { kind: "nkey", seed: Secret.parse(auth.seed), ...optional(auth.token) };
    case "nkeyFile":
      return { kind: "nkeyFile", path: auth.path, ...optional(auth.token) };
    case "creds":
      return { kind: "creds", creds: Secret.parse(auth.creds), ...optional(auth.token) };
    case "credsFile":
      return { kind: "credsFile", path: auth.path, ...optional(auth.token) };
    case "jwt":
      return { kind: "jwt", userJwt: Secret.parse(auth.userJwt), seed: Secret.parse(auth.seed), ...optional(auth.token) };
    case "bearer":
      return { kind: "bearer", userJwt: Secret.parse(auth.userJwt), ...optional(auth.token) };
  }
}

const CREDENTIAL_KEYS = ["NATS_USER", "NATS_CREDS", "NATS_NKEY", "NATS_JWT"] as const;

export function authFromEnv(env: Env, read?: ReadFile): NatsAuth {
  const set = CREDENTIAL_KEYS.filter((key) => env[key]);
  if (set.length > 1) {
    throw invalidArgument(
      "next-nats.config",
      "MULTIPLE_AUTH",
      `Too many types of credentials, choose only one of user, creds, nkey, jwt (found ${set.join(", ")})`,
    );
  }
  const token = literalFromEnv(env, "NATS_TOKEN", read);
  const extra = token ? { token } : {};
  const seed = literalFromEnv(env, "NATS_SEED", read);
  if (seed && !env.NATS_JWT) throw invalidArgument("next-nats.config", "MISSING_JWT", "NATS_SEED requires NATS_JWT");
  if (env.NATS_PASSWORD && !env.NATS_USER) throw invalidArgument("next-nats.config", "MISSING_USER", "NATS_PASSWORD requires NATS_USER");
  switch (set[0]) {
    case "NATS_USER":
      return { kind: "userpass", user: env.NATS_USER!, pass: literalFromEnv(env, "NATS_PASSWORD", read) ?? Secret.of(""), ...extra };
    case "NATS_CREDS": {
      const location = locationFromEnv(env, "NATS_CREDS")!;
      return location.kind === "file" ? { kind: "credsFile", path: location.path, ...extra } : { kind: "creds", creds: location.value, ...extra };
    }
    case "NATS_NKEY": {
      const location = locationFromEnv(env, "NATS_NKEY")!;
      return location.kind === "file" ? { kind: "nkeyFile", path: location.path, ...extra } : { kind: "nkey", seed: location.value, ...extra };
    }
    case "NATS_JWT": {
      const userJwt = literalFromEnv(env, "NATS_JWT", read)!;
      return seed ? { kind: "jwt", userJwt, seed, ...extra } : { kind: "bearer", userJwt, ...extra };
    }
    default:
      return token ? { kind: "token", token } : { kind: "none" };
  }
}

const CREDS_MARKER = "BEGIN NATS USER JWT";

export function decodeCreds(value: string | Secret): Uint8Array {
  const text = Secret.parse(value).reveal().trim();
  if (!text.includes(CREDS_MARKER)) {
    throw invalidArgument("next-nats.config", "INVALID_CREDS", "Credentials are not a creds file: missing a NATS USER JWT block");
  }
  return new TextEncoder().encode(text);
}

export function credsBytes(creds: Secret): Uint8Array {
  return new TextEncoder().encode(`${new TextDecoder().decode(decodeCreds(creds)).trimEnd()}\n`);
}

export const bearerAuthenticator = (userJwt: string): Authenticator => () => ({ jwt: userJwt });

function credentialAuthenticator(auth: PortableAuth): Authenticator | undefined {
  switch (auth.kind) {
    case "none":
      return undefined;
    case "token":
      return tokenAuthenticator(auth.token.reveal());
    case "userpass":
      return usernamePasswordAuthenticator(auth.user, auth.pass.reveal());
    case "nkey":
      return nkeyAuthenticator(new TextEncoder().encode(auth.seed.reveal().trim()));
    case "creds":
      return credsAuthenticator(credsBytes(auth.creds));
    case "jwt":
      return jwtAuthenticator(auth.userJwt.reveal(), new TextEncoder().encode(auth.seed.reveal().trim()));
    case "bearer":
      return bearerAuthenticator(auth.userJwt.reveal());
  }
}

export function withToken(auth: NatsAuth, credential: Authenticator | undefined): Authenticator | undefined {
  const token = auth.kind === "none" || auth.kind === "token" ? undefined : auth.token;
  if (!token) return credential;
  const extra = tokenAuthenticator(token.reveal());
  return credential ? (nonce) => ({ ...credential(nonce), ...extra(nonce) }) as Auth : extra;
}

export function buildPortableAuthenticator(auth: PortableAuth): Authenticator | undefined {
  return withToken(auth, credentialAuthenticator(auth));
}
