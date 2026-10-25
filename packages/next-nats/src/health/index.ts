import "server-only";
import { getNatsConfig, getNats } from "../connection.js";

export interface HealthReport {
  status: "connected" | "disconnected";
  servers: string[];
  server?: { id: string; name: string; version: string; host: string; port: number };
  rttMs?: number;
  jetstream?: { memory: number; storage: number; streams: number; consumers: number };
  error?: string;
}

export async function checkHealth(): Promise<HealthReport> {
  const config = getNatsConfig();
  try {
    const { nc, jsm } = await getNats();
    const [rtt, account] = await Promise.all([nc.rtt(), jsm.getAccountInfo()]);
    const info = nc.info;
    return {
      status: "connected",
      servers: config.servers,
      server: info && {
        id: info.server_id,
        name: info.server_name,
        version: info.version,
        host: info.host,
        port: info.port,
      },
      rttMs: rtt,
      jetstream: {
        memory: account.memory,
        storage: account.storage,
        streams: account.streams,
        consumers: account.consumers,
      },
    };
  } catch (error) {
    return {
      status: "disconnected",
      servers: config.servers,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createHealthHandler() {
  return async function GET(): Promise<Response> {
    const report = await checkHealth();
    return Response.json(report, {
      status: report.status === "connected" ? 200 : 503,
      headers: { "cache-control": "no-store" },
    });
  };
}

export const GET = createHealthHandler();
