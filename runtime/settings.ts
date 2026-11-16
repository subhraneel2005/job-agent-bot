import { config } from "../config";
import { getSetting, setSetting } from "../memory/db";

export function isDryRun(): boolean {
  const v = getSetting("dry_run");
  if (v === null) return config.email.dryRun;
  return v === "1";
}

export function setDryRun(on: boolean) {
  setSetting("dry_run", on ? "1" : "0");
}

export function isPaused(): boolean {
  return getSetting("paused") === "1";
}

export function setPaused(on: boolean) {
  setSetting("paused", on ? "1" : "0");
}

export function runtimeSources(): string[] {
  const v = getSetting("sources");
  if (v === null) return config.discovery.sources;
  if (v === "none") return ["__none__"];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function setRuntimeSources(names: string[]) {
  setSetting("sources", names.length ? names.join(",") : "none");
}

export function runtimeMinFit(): number {
  const v = Number(getSetting("min_fit"));
  return Number.isFinite(v) && v > 0 ? v : config.discovery.minFit;
}

export function setRuntimeMinFit(value: number) {
  setSetting("min_fit", String(Math.round(value)));
}

export function runtimeTopN(): number {
  const v = Number(getSetting("top_n"));
  return Number.isFinite(v) && v > 0 ? Math.min(v, 20) : config.discovery.topN;
}

export function setRuntimeTopN(value: number) {
  setSetting("top_n", String(Math.round(value)));
}

export function runtimeCron(): string {
  return getSetting("cron") ?? config.discovery.cron;
}

export function setRuntimeCron(cron: string) {
  setSetting("cron", cron);
}

export function autoSendEnabled(): boolean {
  return getSetting("auto_send") === "1";
}

export function setAutoSend(on: boolean) {
  setSetting("auto_send", on ? "1" : "0");
}
