import type { NatsConfigInput } from "./config.js";
import { getLogger, setLogger, type Logger } from "./logger.js";

export interface RegisterNatsOptions {
  config?: NatsConfigInput;
  setup?: () => unknown | Promise<unknown>;
  connectOnStart?: boolean;
  onError?: (error: unknown) => void;
  logger?: Logger;
}

export async function registerNats(opts: RegisterNatsOptions = {}): Promise<void> {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureNats, getNats } = await import("./connection.js");
  if (opts.logger) setLogger(opts.logger);
  const onError = opts.onError ?? ((error) => getLogger().error("startup failed", { error }));

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
