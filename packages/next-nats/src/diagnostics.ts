export type DiagnosticsSection = () => unknown | Promise<unknown>;

const REGISTRY_KEY = Symbol.for("next-nats.diagnostics");

function registry(): Map<string, DiagnosticsSection> {
  const g = globalThis as unknown as Record<symbol, Map<string, DiagnosticsSection> | undefined>;
  return (g[REGISTRY_KEY] ??= new Map());
}

export function registerDiagnostics(name: string, section: DiagnosticsSection): () => void {
  const sections = registry();
  sections.set(name, section);
  return () => {
    if (sections.get(name) === section) sections.delete(name);
  };
}

export async function collectDiagnostics(): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    [...registry()].map(async ([name, section]) => {
      try {
        return [name, await section()] as const;
      } catch {
        return [name, { error: "unavailable" }] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
