import { mkdirSync } from "node:fs";
import { join } from "node:path";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function num(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = env(name)?.toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function list(name: string): string[] {
  return (env(name) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const dataDir = env("DATA_DIR") ?? join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(dataDir, "backups"), { recursive: true });

export const config = {
  telegramToken: env("TELEGRAM_BOT_TOKEN") ?? "",
  opencode: {
    apiKey: env("OPENCODE_API_KEY") ?? "",
    baseUrl: env("OPENCODE_API_URL") ?? "https://opencode.ai/inference/go/openai/v1",
    model: env("OPENCODE_MODEL") ?? "deepseek-v4.1-flash",
    sttModel: env("OPENCODE_STT_MODEL") ?? "whisper-1",
    timeoutMs: num("OPENCODE_TIMEOUT_MS", 120_000),
  },
  allowlist: list("ALLOWED_USER_IDS").map((s) => Number(s)).filter(Number.isFinite),
  timezone: env("TZ") ?? "Asia/Kolkata",
  discovery: {
    cron: env("CRON_DISCOVERY") ?? "0 8 * * *",
    freshnessDays: num("FRESHNESS_DAYS", 14),
    topN: num("DIGEST_TOP_N", 8),
    minFit: num("MIN_FIT", 70),
    maxPerSource: num("MAX_PER_SOURCE", 25),
    sources: list("SOURCES"),
    webSearchRss: list("WEB_SEARCH_RSS"),
  },
  memory: {
    ragDimensions: num("RAG_DIMENSIONS", 512),
    ragChunkChars: num("RAG_CHUNK_CHARS", 900),
    ragChunkOverlap: num("RAG_CHUNK_OVERLAP", 120),
    recallK: num("RECALL_K", 5),
  },
  email: {
    dryRun: bool("DRY_RUN", true),
    from: env("EMAIL_FROM") ?? "job-agent-bot@example.com",
    replyTo: env("EMAIL_REPLY_TO") ?? "",
    resendApiKey: env("RESEND_API_KEY") ?? "",
    smtpUrl: env("SMTP_URL") ?? "",
  },
  user: {
    name: env("USER_NAME") ?? "",
    email: env("USER_EMAIL") ?? "",
    github: env("USER_GITHUB") ?? "",
    linkedin: env("USER_LINKEDIN") ?? "",
    website: env("USER_WEBSITE") ?? "",
  },
  followUpDays: list("FOLLOW_UP_DAYS").map(Number).filter(Number.isFinite).length
    ? list("FOLLOW_UP_DAYS").map(Number).filter(Number.isFinite)
    : [4, 10],
  dataDir,
  dbPath: join(dataDir, "agent.db"),
  logPath: join(dataDir, "agent.log"),
  backupDir: join(dataDir, "backups"),
  maxAgentSteps: num("MAX_AGENT_STEPS", 8),
  maxResponseChars: num("MAX_RESPONSE_CHARS", 4000),
} as const;

export type Config = typeof config;

export function requireSecrets(): string[] {
  const missing: string[] = [];
  if (!config.telegramToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!config.opencode.apiKey) missing.push("OPENCODE_API_KEY");
  return missing;
}
