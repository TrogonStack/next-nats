"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { upload } from "@vercel/blob/client";

export function Uploader() {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get("file");
    if (!(file instanceof File) || file.size === 0) return;
    setBusy(true);
    try {
      setStatus(`Uploading ${file.size} bytes`);
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
        multipart: file.size > 16 * 1024 * 1024,
        onUploadProgress: ({ percentage }) => setStatus(`Uploading ${Math.round(percentage)}%`),
      });
      setStatus(`Stored as ${blob.pathname}`);
      router.refresh();
    } catch (error) {
      setStatus(`Failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: "0.5rem", maxWidth: 360 }}>
      <input type="file" name="file" required />
      <button disabled={busy}>{busy ? "Uploading" : "Upload"}</button>
      {status && <output>{status}</output>}
    </form>
  );
}
