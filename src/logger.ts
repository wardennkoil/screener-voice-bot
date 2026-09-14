import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";
const pretty = process.stdout.isTTY && process.env.NODE_ENV !== "production";

export const logger = pino({
  level,
  ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } } } : {}),
});

/** The subset of a pino-style logger the app uses; satisfied by pino and by Fastify's request loggers. */
export interface Logger {
  level: string;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}
