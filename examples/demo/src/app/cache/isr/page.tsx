import { Suspense } from "react";
import { connection } from "next/server";
import { expireIsr } from "../_server/actions/cache";
import { Replica } from "../replica";

async function Clock() {
  await connection();
  const origin = process.env.CLOCK_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
  const res = await fetch(`${origin}/api/cache/clock`, { cache: "force-cache", next: { tags: ["demo-isr"], revalidate: 300 } });
  const clock = (await res.json()) as { at: string; nonce: string };
  return (
    <p>
      fetched <code data-testid="isr">{clock.at}</code> nonce <code data-testid="isr-nonce">{clock.nonce}</code>
    </p>
  );
}

export default function Page() {
  return (
    <main>
      <h1>Cache ISR</h1>
      <Suspense fallback={<p>loading</p>}>
        <Clock />
      </Suspense>
      <p>
        served by{" "}
        <Suspense fallback="...">
          <Replica />
        </Suspense>
      </p>
      <form>
        <button formAction={expireIsr}>updateTag demo-isr</button>
      </form>
    </main>
  );
}
