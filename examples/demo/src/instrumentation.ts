export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNats } = await import("next-nats/instrumentation");
    await registerNats({
      setup: () => import("./services/nats/consumers"),
    });
  }
}
