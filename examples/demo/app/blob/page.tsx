import { list } from "next-nats/blob";
import { features } from "@/lib/features";
import { deleteBlob } from "./actions";
import { Uploader } from "./uploader";

export const dynamic = "force-dynamic";

const feature = features.find((f) => f.slug === "blob")!;

export default async function Page() {
  const { blobs } = await list({ limit: 100 });
  return (
    <main>
      <h1>{feature.title}</h1>
      <p>{feature.blurb}</p>
      <h2>Upload</h2>
      <Uploader />
      <h2>Blobs</h2>
      {blobs.length === 0 && <p>Nothing uploaded yet.</p>}
      <ul style={{ paddingLeft: "1.25rem", display: "grid", gap: "0.5rem" }}>
        {blobs.map((blob) => (
          <li key={blob.pathname}>
            <a href={blob.url}>{blob.pathname}</a> <small>{blob.size} bytes</small>{" "}
            <a href={blob.downloadUrl}>download</a>
            <form action={deleteBlob} style={{ display: "inline" }}>
              <input type="hidden" name="pathname" value={blob.pathname} />{" "}
              <button>delete</button>
            </form>
          </li>
        ))}
      </ul>
    </main>
  );
}
