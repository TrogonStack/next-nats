import { connection } from "next/server";
import { kv } from "next-nats/kv";
import { features } from "@/lib/features";
import { CounterForm, DeleteForm, ProfileForm, SetForm } from "./forms";

const feature = features.find((f) => f.slug === "kv")!;

export default async function Page() {
  await connection();
  const keys = await kv.keys("*");
  const entries = await Promise.all(
    keys.map(async (key) => ({ key, type: await kv.type(key), ttl: await kv.ttl(key), value: await read(key) })),
  );
  return (
    <main>
      <h1>{feature.title}</h1>
      <p>{feature.blurb}</p>
      <p>
        Bucket <code>{kv.bucket}</code>
      </p>
      <h2>Keys</h2>
      {entries.length === 0 ? (
        <p>No keys yet.</p>
      ) : (
        <ul>
          {entries.map((e) => (
            <li key={e.key}>
              <code>{e.key}</code> ({e.type}, ttl {e.ttl}): <code>{JSON.stringify(e.value)}</code>
            </li>
          ))}
        </ul>
      )}
      <h2>Atomic counter</h2>
      <CounterForm />
      <h2>Set a key</h2>
      <SetForm />
      <h2>Hash</h2>
      <ProfileForm />
      <h2>Delete</h2>
      <DeleteForm />
    </main>
  );
}

async function read(key: string): Promise<unknown> {
  return (await kv.type(key)) === "hash" ? kv.hgetall(key) : kv.get(key);
}
