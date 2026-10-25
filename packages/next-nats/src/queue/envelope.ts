import { codec } from "../codec.js";

export interface Envelope {
  id: string;
  createdAt: number;
  expiresAt: number;
  enc: "json" | "text" | "base64";
  data: unknown;
  headers?: Record<string, string>;
}

export function encodeEnvelope(id: string, payload: unknown, createdAt: number, expiresAt: number, headers?: Record<string, string>): Uint8Array {
  let enc: Envelope["enc"] = "json";
  let data: unknown = payload;
  if (payload instanceof Uint8Array) {
    enc = "base64";
    data = Buffer.from(payload).toString("base64");
  } else if (typeof payload === "string") {
    enc = "text";
  }
  const envelope: Envelope = { id, createdAt, expiresAt, enc, data, ...(headers && Object.keys(headers).length > 0 && { headers }) };
  return codec.encodeJson(envelope);
}

export function decodeEnvelope<T>(bytes: Uint8Array): { envelope: Envelope; payload: T } {
  const envelope = codec.decodeJson<Envelope>(bytes);
  const payload = (envelope.enc === "base64" ? Buffer.from(envelope.data as string, "base64") : envelope.data) as T;
  return { envelope, payload };
}
