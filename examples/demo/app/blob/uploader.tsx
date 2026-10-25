"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { requestUpload } from "./actions";

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
      const type = file.type || "application/octet-stream";
      const { url } = await requestUpload(file.name, type);
      setStatus(`Uploading ${file.size} bytes`);
      const response = await fetch(url, { method: "PUT", body: file, headers: { "content-type": type } });
      const body = (await response.json()) as { pathname?: string; error?: string };
      setStatus(response.ok ? `Stored as ${body.pathname}` : `Failed: ${body.error}`);
      router.refresh();
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
