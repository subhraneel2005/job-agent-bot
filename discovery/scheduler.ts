import { config } from "../config";
import { log, serializeError } from "../logger";
import { db } from "../memory/db";
import { isPaused, runtimeCron } from "../runtime/settings";

type CronFields = { minute: number; hour: number; dom: number | null; month: number | null; dow: number | null };

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Unsupported cron expression: "${expr}"`);
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const num = (value: string, min: number, max: number): number | null => {
    if (value === "*") return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Bad cron field: ${value}`);
    return n;
  };
  return {
    minute: num(minute, 0, 59) ?? 0,
    hour: num(hour, 0, 23) ?? 0,
    dom: num(dom, 1, 31),
    month: num(month, 1, 12),
    dow: num(dow, 0, 6),
  };
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function tzParts(date: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? "Sun"] ?? 0,
  };
}

export function nextRun(expr: string, from = new Date()): Date {
  const cron = parseCron(expr);
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const maxMinutes = 8 * 24 * 60;
  for (let i = 0; i < maxMinutes; i++) {
    const candidate = new Date(start.getTime() + i * 60_000);
    const p = tzParts(candidate);
    if (p.minute !== cron.minute || p.hour !== cron.hour) continue;
    if (cron.dom !== null && p.day !== cron.dom) continue;
    if (cron.month !== null && p.month !== cron.month) continue;
    if (cron.dow !== null && p.weekday !== cron.dow) continue;
    return candidate;
  }
  throw new Error(`Could not compute next run for cron "${expr}"`);
}

export function activeChatIds(): number[] {
  const rows = db.query("SELECT chat_id FROM users").all() as { chat_id: number }[];
  if (rows.length) return rows.map((r) => r.chat_id);
  return [...config.allowlist];
}

let timer: ReturnType<typeof setTimeout> | null = null;
let nextAt: Date | null = null;
let running = false;
let stopped = false;
let lastRunAt: Date | null = null;

export function schedulerState() {
  return {
    running,
    paused: isPaused(),
    nextRunAt: nextAt?.toISOString() ?? null,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    cron: runtimeCron(),
    timezone: config.timezone,
  };
}

export function startScheduler(onRun: (chatId: number) => Promise<void>) {
  stopped = false;
  const schedule = () => {
    if (stopped) return;
    try {
      nextAt = nextRun(runtimeCron());
    } catch (error) {
      log.error("scheduler.cron_invalid", serializeError(error));
      return;
    }
    const delay = Math.max(1000, nextAt.getTime() - Date.now());
    log.info("scheduler.armed", { nextRunAt: nextAt.toISOString(), delayMs: delay });
    timer = setTimeout(async () => {
      timer = null;
      if (stopped) return;
      if (isPaused()) {
        log.info("scheduler.paused_skip");
        schedule();
        return;
      }
      running = true;
      lastRunAt = new Date();
      const chats = activeChatIds();
      log.info("scheduler.run_start", { chats });
      for (const chatId of chats) {
        try {
          await onRun(chatId);
        } catch (error) {
          log.error("scheduler.chat_run_failed", { chatId, ...serializeError(error) });
        }
      }
      running = false;
      schedule();
    }, delay);
  };
  schedule();
}

export function stopScheduler() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  nextAt = null;
}

export function stopIfRunning() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
