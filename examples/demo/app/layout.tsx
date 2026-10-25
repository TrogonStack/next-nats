import type { ReactNode } from "react";
import Link from "next/link";

export const metadata = { title: "next-nats demo" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
        <header style={{ display: "flex", gap: "1rem", alignItems: "baseline", marginBottom: "2rem" }}>
          <Link href="/"><strong>next-nats</strong></Link>
          <a href="/api/nats/health">health</a>
        </header>
        {children}
      </body>
    </html>
  );
}
