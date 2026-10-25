"use server";
import "server-only";

import { revalidateTag, updateTag } from "next/cache";

export async function expireNow() {
  updateTag("demo-cache");
}

export async function revalidateInBackground() {
  revalidateTag("demo-cache", "max");
}

export async function expireIsr() {
  updateTag("demo-isr");
}
