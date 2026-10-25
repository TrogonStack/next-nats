export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNats } = await import("@trogonstack/next-nats/instrumentation");
    await registerNats({
      vercelCrons: true,
      setup: () => import("./services/nats/consumers"),
    });
  }
}
