import { connection } from "next/server";
import { createBlobRoute } from "@trogonstack/next-nats/blob";

const route = createBlobRoute();

export async function GET(...args: Parameters<typeof route.GET>) {
  await connection();
  return route.GET(...args);
}

export async function HEAD(...args: Parameters<typeof route.HEAD>) {
  await connection();
  return route.HEAD(...args);
}

export async function PUT(...args: Parameters<typeof route.PUT>) {
  await connection();
  return route.PUT(...args);
}
