export type Type = "string" | "list" | "set" | "zset" | "hash" | "none";

export type ExpireOption = "NX" | "nx" | "XX" | "xx" | "GT" | "gt" | "LT" | "lt";

export type SetCommandOptions = {
  get?: boolean;
} & (
  | { ex: number; px?: never; exat?: never; pxat?: never; keepTtl?: never }
  | { ex?: never; px: number; exat?: never; pxat?: never; keepTtl?: never }
  | { ex?: never; px?: never; exat: number; pxat?: never; keepTtl?: never }
  | { ex?: never; px?: never; exat?: never; pxat: number; keepTtl?: never }
  | { ex?: never; px?: never; exat?: never; pxat?: never; keepTtl: true }
  | { ex?: never; px?: never; exat?: never; pxat?: never; keepTtl?: never }
) &
  ({ nx: true; xx?: never } | { xx: true; nx?: never } | { xx?: never; nx?: never });

export type GetExCommandOptions =
  | { ex: number; px?: never; exat?: never; pxat?: never; persist?: never }
  | { ex?: never; px: number; exat?: never; pxat?: never; persist?: never }
  | { ex?: never; px?: never; exat: number; pxat?: never; persist?: never }
  | { ex?: never; px?: never; exat?: never; pxat: number; persist?: never }
  | { ex?: never; px?: never; exat?: never; pxat?: never; persist: true }
  | { ex?: never; px?: never; exat?: never; pxat?: never; persist?: never };

export type ScanCommandOptionsStandard = {
  match?: string;
  count?: number;
  type?: string;
  withType?: false;
};

export type ScanCommandOptionsWithType = {
  match?: string;
  count?: number;
  withType: true;
};

export type ScanCommandOptions = ScanCommandOptionsStandard | ScanCommandOptionsWithType;

export type ScanResultStandard = [string, string[]];
export type ScanResultWithType = [string, { key: string; type: string }[]];

export type ScoreMember<TData> = { score: number; member: TData };

type NXAndXXOptions = { nx: true; xx?: never } | { nx?: never; xx: true } | { nx?: never; xx?: never };
type LTAndGTOptions = { lt: true; gt?: never } | { lt?: never; gt: true } | { lt?: never; gt?: never };

export type ZAddCommandOptions = NXAndXXOptions & LTAndGTOptions & { ch?: true } & { incr?: true };

export type ZRangeCommandOptions = {
  withScores?: boolean;
  rev?: boolean;
} & (
  | { byScore: true; byLex?: never }
  | { byScore?: never; byLex: true }
  | { byScore?: never; byLex?: never }
) &
  ({ offset: number; count: number } | { offset?: never; count?: never });

type Weights =
  | { weight: number; weights?: never }
  | { weight?: never; weights: number[] }
  | { weight?: never; weights?: never };

export type ZInterStoreCommandOptions = { aggregate?: "sum" | "min" | "max" } & Weights;
export type ZUnionStoreCommandOptions = { aggregate?: "sum" | "min" | "max" } & Weights;
export type ZUnionCommandOptions = { withScores?: boolean; aggregate?: "sum" | "min" | "max" } & Weights;

export type RedisOptions = {
  automaticDeserialization?: boolean;
  latencyLogging?: boolean;
  enableTelemetry?: boolean;
  enableAutoPipelining?: boolean;
  readYourWrites?: boolean;
};

export type RedisConfigNodejs = {
  url?: string | undefined;
  token?: string | undefined;
  signal?: unknown;
  latencyLogging?: boolean;
  agent?: unknown;
  keepAlive?: boolean;
  readYourWrites?: boolean;
  retry?: unknown;
  responseEncoding?: unknown;
  cache?: unknown;
  headers?: unknown;
  baseUrl?: unknown;
  bucket?: string;
} & RedisOptions;
