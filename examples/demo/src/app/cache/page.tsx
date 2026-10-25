import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { cacheLife, cacheTag } from "next/cache";
import { features } from "@/constants/features";
import { expireNow, revalidateInBackground } from "./_server/actions/cache";
import { Replica } from "./replica";

const feature = features.find((f) => f.slug === "cache")!;

async function CachedValue({ scope }: { scope: string }) {
  "use cache";
  cacheTag("demo-cache");
  cacheLife({ stale: 5, revalidate: 300, expire: 3600 });
  return (
    <p data-scope={scope}>
      generated <code data-testid="cached">{new Date().toISOString()}</code> nonce{" "}
      <code data-testid="nonce">{Math.random().toString(36).slice(2, 10)}</code>
    </p>
  );
}

async function PerRequest() {
  await connection();
  return <CachedValue scope={process.env.NEXT_NATS_CACHE_NAMESPACE ?? "default"} />;
}

export default function Page() {
  return (
    <main>
      <h1>{feature.title}</h1>
      <p>{feature.blurb}</p>
      <h2>use cache</h2>
      <Suspense fallback={<p>loading</p>}>
        <PerRequest />
      </Suspense>
      <p>
        served by{" "}
        <Suspense fallback="...">
          <Replica />
        </Suspense>
      </p>
      <form style={{ display: "flex", gap: "0.5rem" }}>
        <button formAction={expireNow}>updateTag</button>
        <button formAction={revalidateInBackground}>revalidateTag</button>
      </form>
      <p>
        <Link href="/cache/isr">ISR page</Link>
      </p>
    </main>
  );
}
