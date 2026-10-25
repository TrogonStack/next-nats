export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
} as const;
export type LogLevelName = keyof typeof LogLevel;
export type LogLevel = (typeof LogLevel)[LogLevelName];

export interface LogContext {
  readonly error?: unknown;
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warning(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export function consoleLogger(minimum: LogLevel = LogLevel.INFO): Logger {
  const emit = (level: LogLevel, sink: (...args: unknown[]) => void) => (message: string, context?: LogContext) => {
    if (level < minimum) return;
    if (context === undefined) sink(`[next-nats] ${message}`);
    else sink(`[next-nats] ${message}`, context);
  };
  return {
    debug: emit(LogLevel.DEBUG, console.debug),
    info: emit(LogLevel.INFO, console.info),
    warning: emit(LogLevel.WARNING, console.warn),
    error: emit(LogLevel.ERROR, console.error),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warning() {},
  error() {},
};

const LOGGER_KEY = Symbol.for("next-nats.logger");
const THROTTLE_KEY = Symbol.for("next-nats.logger.throttle");

type Holder = Record<symbol, unknown>;

export function setLogger(logger: Logger): void {
  (globalThis as Holder)[LOGGER_KEY] = logger;
}

export function getLogger(): Logger {
  const holder = globalThis as Holder;
  return (holder[LOGGER_KEY] ??= consoleLogger()) as Logger;
}

export function warnThrottled(key: string, message: string, context?: LogContext, intervalMs = 30_000): void {
  const holder = globalThis as Holder;
  const seen = (holder[THROTTLE_KEY] ??= new Map<string, number>()) as Map<string, number>;
  const now = Date.now();
  const last = seen.get(key);
  if (last !== undefined && now - last < intervalMs) return;
  seen.set(key, now);
  getLogger().warning(message, context);
}
