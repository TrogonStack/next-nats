import { invalidArgument } from "./errors.js";
import type { Brand } from "./values.js";

export type SynadiaRegion = Brand<string, "SynadiaRegion">;

const GLOBAL = "global";
const GEO_REGIONS = ["eu", "us", "asia", "west.us", "east.us"] as const;
const REGIONS: readonly string[] = [GLOBAL, ...GEO_REGIONS];

export const DEFAULT_SYNADIA_REGION = GLOBAL as SynadiaRegion;

export function synadiaRegion(value: string): SynadiaRegion {
  const region = value.trim().toLowerCase();
  if (!REGIONS.includes(region)) {
    throw invalidArgument("next-nats.config", "INVALID_SYNADIA_REGION", `Invalid Synadia Cloud region "${value}": use ${REGIONS.join(", ")}`);
  }
  return region as SynadiaRegion;
}

function host(region: SynadiaRegion): string {
  return region === GLOBAL ? "connect.ngs.global" : `${region}.geo.ngs.global`;
}

export function synadiaServers(region: SynadiaRegion): { servers: string[]; wsServers: string[] } {
  return { servers: [`tls://${host(region)}`], wsServers: [`wss://${host(region)}:443`] };
}
