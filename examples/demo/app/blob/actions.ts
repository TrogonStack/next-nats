"use server";

import { revalidatePath } from "next/cache";
import { createUploadUrl, del } from "next-nats/blob";

export async function requestUpload(pathname: string, contentType: string): Promise<{ url: string }> {
  const { url } = createUploadUrl(pathname, {
    addRandomSuffix: true,
    maximumSizeInBytes: 256 * 1024 * 1024,
    expiresIn: 5 * 60_000,
    ...(contentType && { allowedContentTypes: [contentType] }),
  });
  return { url };
}

export async function deleteBlob(formData: FormData): Promise<void> {
  const pathname = String(formData.get("pathname") ?? "");
  if (pathname) await del(pathname);
  revalidatePath("/blob");
}
