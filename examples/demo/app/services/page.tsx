import { discover } from "next-nats/services";
import { features } from "@/lib/features";
import { CalcForm, ScatterButton } from "./form";

export const dynamic = "force-dynamic";

const feature = features.find((f) => f.slug === "services")!;

const ms = (nanos: number) => (nanos / 1_000_000).toFixed(2);

export default async function Page() {
  const found = await discover({ timeout: 400 });
  const rows = found.stats.flatMap((s) =>
    (s.endpoints ?? []).map((e) => ({
      service: s.name,
      instance: s.id.slice(-6),
      endpoint: e.name,
      subject: e.subject,
      requests: e.num_requests,
      errors: (e.data as { errors?: number } | null | undefined)?.errors ?? e.num_errors,
      avg: ms(e.average_processing_time),
      lastError: (e.data as { lastError?: string } | null | undefined)?.lastError ?? e.last_error ?? "",
    })),
  );
  return (
    <main style={{ display: "grid", gap: "1.5rem" }}>
      <header>
        <h1>{feature.title}</h1>
        <p>{feature.blurb}</p>
      </header>
      <section style={{ display: "grid", gap: "0.5rem" }}>
        <h2>Request/reply from a Server Action</h2>
        <p>Divide by zero returns a mapped service error (422). Reload to see stats move.</p>
        <CalcForm />
      </section>
      <section style={{ display: "grid", gap: "0.5rem" }}>
        <h2>Scatter-gather</h2>
        <p>The probe service has no queue group, so every instance answers one request.</p>
        <ScatterButton />
      </section>
      <section style={{ display: "grid", gap: "0.5rem" }}>
        <h2>Discovery</h2>
        <p>
          {found.ping.length} instance(s) answered ping:{" "}
          {found.info.map((i) => `${i.name}@${i.version}`).filter((v, i, all) => all.indexOf(v) === i).join(", ")}
        </p>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr>
              {["service", "instance", "endpoint", "subject", "requests", "errors", "avg ms", "last error"].map((h) => (
                <th key={h} style={{ textAlign: "left", padding: "2px 8px" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.instance}-${r.endpoint}`}>
                <td style={{ padding: "2px 8px" }}>{r.service}</td>
                <td style={{ padding: "2px 8px" }}>{r.instance}</td>
                <td style={{ padding: "2px 8px" }}>{r.endpoint}</td>
                <td style={{ padding: "2px 8px" }}>{r.subject}</td>
                <td style={{ padding: "2px 8px" }}>{r.requests}</td>
                <td style={{ padding: "2px 8px" }}>{r.errors}</td>
                <td style={{ padding: "2px 8px" }}>{r.avg}</td>
                <td style={{ padding: "2px 8px" }}>{r.lastError}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
