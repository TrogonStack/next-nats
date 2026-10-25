import type { NatsConfigInput } from "./config.js";

export interface RegisterNatsOptions {
  config?: NatsConfigInput;
  setup?: () => unknown | Promise<unknown>;
  connectOnStart?: boolean;
  onError?: (error: unknown) => void;
}

export async function registerNats(opts: RegisterNatsOptions = {}): Promise<void> {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureNats, getNats } = await import("./connection.js");
  const onError = opts.onError ?? ((error) => console.error("[next-nats] startup failed:", error));

  if (opts.config) configureNats(opts.config);

  if (opts.connectOnStart ?? true) {
    try {
      await getNats();
    } catch (error) {
      onError(error);
    }
  }

  if (opts.setup) {
    try {
      await opts.setup();
    } catch (error) {
      onError(error);
    }
  }
}
