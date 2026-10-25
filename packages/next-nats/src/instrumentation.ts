import type { NatsConfigInput } from "./config.js";
import type { VercelCronsOptions } from "./cron/vercel.js";
import { getLogger, setLogger, type Logger } from "./logger.js";

export interface RegisterNatsOptions {
  config?: NatsConfigInput;
  setup?: () => unknown | Promise<unknown>;
  connectOnStart?: boolean;
  vercelCrons?: boolean | VercelCronsOptions;
  onError?: (error: unknown) => void;
  logger?: Logger;
}

export async function registerNats(opts: RegisterNatsOptions = {}): Promise<void> {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureNats, getNats, trackInitialization } = await import("./connection.js");
  if (opts.logger) setLogger(opts.logger);
  const onError = opts.onError ?? ((error) => getLogger().error("startup failed", { error }));

  await trackInitialization(async () => {
    if (opts.config) configureNats(opts.config);

    if (opts.connectOnStart ?? true) {
      try {
        await getNats();
      } catch (error) {
        onError(error);
      }
    }

    if (opts.vercelCrons) {
      try {
        const { registerVercelCrons } = await import("./cron/vercel.js");
        registerVercelCrons(opts.vercelCrons === true ? {} : opts.vercelCrons);
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
  });
}
