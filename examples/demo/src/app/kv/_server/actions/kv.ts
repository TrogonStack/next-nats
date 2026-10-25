"use server";
import "server-only";

import { revalidatePath } from "next/cache";
import { kv } from "next-nats/kv";

export type KvState = { message: string };

const text = (data: FormData, name: string) => String(data.get(name) ?? "").trim();

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function setKey(_prev: KvState, data: FormData): Promise<KvState> {
  const key = text(data, "key");
  if (!key) return { message: "Key is required" };
  const ex = Number(text(data, "ex"));
  const nx = data.get("nx") === "on";
  const result = await kv.set(key, parse(text(data, "value")), {
    ...(ex > 0 && { ex }),
    ...(nx && { nx: true }),
  });
  revalidatePath("/kv");
  return { message: result === "OK" ? `SET ${key} OK${ex > 0 ? ` (expires in ${ex}s)` : ""}` : `SET ${key} skipped (key exists)` };
}

export async function deleteKey(_prev: KvState, data: FormData): Promise<KvState> {
  const key = text(data, "key");
  const removed = await kv.del(key);
  revalidatePath("/kv");
  return { message: `DEL ${key} removed ${removed}` };
}

export async function incrementCounter(_prev: KvState, data: FormData): Promise<KvState> {
  const by = Number(text(data, "by")) || 1;
  const value = await kv.incrby("demo:counter", by);
  revalidatePath("/kv");
  return { message: `INCRBY demo:counter ${by} = ${value}` };
}

export async function setProfileField(_prev: KvState, data: FormData): Promise<KvState> {
  const field = text(data, "field");
  if (!field) return { message: "Field is required" };
  await kv.hset("demo:profile", { [field]: parse(text(data, "value")) });
  revalidatePath("/kv");
  return { message: `HSET demo:profile ${field}` };
}
