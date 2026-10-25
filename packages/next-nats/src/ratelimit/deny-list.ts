import { UnsupportedCommandError } from "../redis/errors.js";
import type { Redis } from "../redis/redis.js";

export class ThresholdError extends Error {
  constructor(threshold: number) {
    super(`Allowed threshold values are from 1 to 100, 1 and 100 included. Received: ${threshold}`);
    this.name = "ThresholdError";
  }
}

export const updateIpDenyList = async (_redis: Redis, _prefix: string, _threshold: number, _ttl?: number): Promise<unknown[]> => {
  throw new UnsupportedCommandError("IpDenyList.updateIpDenyList");
};

export const disableIpDenyList = async (_redis: Redis, _prefix: string): Promise<unknown[]> => {
  throw new UnsupportedCommandError("IpDenyList.disableIpDenyList");
};
