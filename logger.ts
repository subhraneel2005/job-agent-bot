import { appendFileSync } from "node:fs";
import { config } from "./config";

export type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

export type LogContext = Record<string, unknown>;

function write(level: Level, message: string, ctx?: LogContext) {
  if (LEVELS[level] < threshold) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(ctx ?? {}),
  };
  const line = JSON.stringify(record);
  const color = COLORS[level];
  console.log(`${color}${level.toUpperCase().padEnd(5)}${RESET} ${message}${ctx && Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : ""}`);
  try {
    appendFileSync(config.logPath, line + "\n");
  } catch {
    // logging must never crash the agent
  }
}

export const log = {
  debug: (msg: string, ctx?: LogContext) => write("debug", msg, ctx),
  info: (msg: string, ctx?: LogContext) => write("info", msg, ctx),
  warn: (msg: string, ctx?: LogContext) => write("warn", msg, ctx),
  error: (msg: string, ctx?: LogContext) => write("error", msg, ctx),
};

let counter = 0;
export function newRunId(): string {
  counter = (counter + 1) % 10_000;
  const stamp = Date.now().toString(36);
  return `run_${stamp}_${counter.toString(36)}`;
}

export function serializeError(error: unknown): LogContext {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { value: String(error) };
}
