import { credsAuthenticator, jwtAuthenticator, nkeyAuthenticator, tokenAuthenticator, usernamePasswordAuthenticator, type Auth, type Authenticator } from "@nats-io/nats-core";
import { credsBytes, type NatsAuth, type PortableAuth } from "./auth.js";

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
