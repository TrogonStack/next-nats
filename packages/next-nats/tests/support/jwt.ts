import { createHash } from "node:crypto";
import { nkeys } from "@nats-io/nats-core";

const b64 = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");

type Keys = ReturnType<typeof nkeys.createUser>;

function sign(issuer: Keys, subject: string, name: string, nats: Record<string, unknown>, exp?: number): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { jti: "", iat, iss: issuer.getPublicKey(), name, sub: subject, ...(exp !== undefined && { exp }), nats };
  claims.jti = createHash("sha256").update(JSON.stringify(claims)).digest("base64url");
  const signingInput = `${b64(JSON.stringify({ typ: "JWT", alg: "ed25519-nkey" }))}.${b64(JSON.stringify(claims))}`;
  return `${signingInput}.${b64(issuer.sign(new TextEncoder().encode(signingInput)))}`;
}

export interface TestOperator {
  readonly conf: string;
  readonly account: Keys;
  user(name: string, exp?: number, bearer?: boolean): { creds: string; jwt: string; seed: string; publicKey: string };
}

export function createTestOperator(extraConf = ""): TestOperator {
  const operator = nkeys.createOperator();
  const account = nkeys.createAccount();
  const opPub = operator.getPublicKey();
  const accPub = account.getPublicKey();
  const operatorJwt = sign(operator, opPub, "op", { type: "operator", version: 2 });
  const accountJwt = sign(operator, accPub, "acc", {
    type: "account",
    version: 2,
    limits: { subs: -1, data: -1, payload: -1, conn: -1, leaf: -1, imports: -1, exports: -1, wildcards: true, mem_storage: -1, disk_storage: -1, streams: -1, consumer: -1 },
  });
  const system = nkeys.createAccount();
  const systemJwt = sign(operator, system.getPublicKey(), "sys", { type: "account", version: 2, limits: {} });
  const conf = `
port: 4222
http: 8222
operator: ${operatorJwt}
resolver: MEMORY
system_account: ${system.getPublicKey()}
resolver_preload: { ${accPub}: ${accountJwt}, ${system.getPublicKey()}: ${systemJwt} }
${extraConf}
`;
  return {
    conf,
    account,
    user(name, exp, bearer) {
      const user = nkeys.createUser();
      const seed = new TextDecoder().decode(user.getSeed());
      const jwt = sign(account, user.getPublicKey(), name, { type: "user", version: 2, pub: {}, sub: {}, subs: -1, data: -1, payload: -1, ...(bearer && { bearer_token: true }) }, exp);
      const creds = `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n${seed}\n------END USER NKEY SEED------\n`;
      return { creds, jwt, seed, publicKey: user.getPublicKey() };
    },
  };
}
