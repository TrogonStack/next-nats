import "server-only";
import { JetStreamApiError, JetStreamApiCodes, type StreamConfig, type StreamInfo } from "@nats-io/jetstream";
import { getNats } from "./connection.js";

export type StreamSpec = Partial<StreamConfig> & { name: string };

export async function ensureStream(spec: StreamSpec): Promise<StreamInfo> {
  const { jsm } = await getNats();
  try {
    return await jsm.streams.info(spec.name);
  } catch (err) {
    if (!(err instanceof JetStreamApiError) || err.code !== JetStreamApiCodes.StreamNotFound) throw err;
  }
  return jsm.streams.add(spec);
}
