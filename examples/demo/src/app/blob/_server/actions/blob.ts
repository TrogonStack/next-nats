"use server";
import "server-only";

import { revalidatePath } from "next/cache";
import { del } from "@vercel/blob";

export async function deleteBlob(formData: FormData): Promise<void> {
  const pathname = String(formData.get("pathname") ?? "");
  if (pathname) await del(pathname);
  revalidatePath("/blob");
}
