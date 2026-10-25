import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
export const DEMO_ROOT = `${REPOSITORY_ROOT}examples/demo`;
export const BUILD_ROOT = ".next-e2e";

export type BuildVariant = "turbopack" | "webpack" | "vercel";
export type SelfHostedVariant = Exclude<BuildVariant, "vercel">;

export const BUILD_VARIANTS: readonly BuildVariant[] = ["turbopack", "webpack", "vercel"];
export const SELF_HOSTED_VARIANTS: readonly SelfHostedVariant[] = ["turbopack", "webpack"];

export function composeProject(): string {
  return process.env.NEXT_NATS_COMPOSE_PROJECT ?? "next-nats";
}

export function natsServers(): string {
  return process.env.NATS_SERVERS ?? `nats://nats.${composeProject()}.orb.local:4222`;
}

export function distDirOf(variant: BuildVariant): string {
  return `${BUILD_ROOT}/${variant}`;
}

export function distPathOf(variant: BuildVariant): string {
  return `${DEMO_ROOT}/${distDirOf(variant)}`;
}

export const PORT_RANGE = { first: 3840, last: 3859 } as const;
