"use server";
import "server-only";

import { revalidatePath } from "next/cache";
import { has, setEdgeConfigItems } from "next-nats/edge-config";

export type EdgeConfigState = { message: string };

const text = (data: FormData, name: string) => String(data.get(name) ?? "").trim();

async function settled(key: string, present: boolean): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if ((await has(key)) === present) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function upsertItem(_prev: EdgeConfigState, data: FormData): Promise<EdgeConfigState> {
  const key = text(data, "key");
  if (!key) return { message: "Key is required" };
  const raw = text(data, "value");
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  await setEdgeConfigItems([{ operation: "upsert", key, value: value as never }]);
  await settled(key, true);
  revalidatePath("/edge-config");
  return { message: `Wrote ${key}; this process mirror picked it up through kv.watch()` };
}

export async function deleteItem(_prev: EdgeConfigState, data: FormData): Promise<EdgeConfigState> {
  const key = text(data, "key");
  try {
    await setEdgeConfigItems([{ operation: "delete", key }]);
  } catch (err) {
    return { message: err instanceof Error ? err.message : "Delete failed" };
  }
  await settled(key, false);
  revalidatePath("/edge-config");
  return { message: `Deleted ${key}` };
}
