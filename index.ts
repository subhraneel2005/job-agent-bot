import { Bot, InlineKeyboard } from "grammy";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { config, requireSecrets } from "./config";
import { log, newRunId, serializeError } from "./logger";
import {
  addFeedback,
  addPipelineEvent,
  backupDb,
  db,
  ensureUser,
  enqueueOutbox,
  feedbackCounts,
  finishRun,
  getOpportunity,
  getOutreach,
  getRun,
  insertRun,
  listFacts,
  listOpportunities,
  listOutreachByRun,
  listPendingOutbox,
  markOutboxFailed,
  markOutboxSent,
  setOpportunityStatus,
  setSetting,
} from "./memory/db";
import { ingestDocument, ingestMemory, memoryStats, recall } from "./memory/rag";
import { BOT_COMMANDS } from "./telegram/commands";
import { ProgressReporter } from "./telegram/progress";
import { chunkMessage, plainFromHtml, renderHtml } from "./telegram/format";
import { isParseError, withRetry } from "./telegram/retry";
import { clearSession, runAgent, sessionSize } from "./agent/loop";
import { enqueue } from "./runtime/queue";
import { transcribeAudio } from "./ai/client";
import { extractDocument } from "./ingest/extract";
import { whisperCppStatus } from "./stt/whispercpp";
import { runDiscovery, type DiscoveryResult } from "./discovery/pipeline";
import { buildDigestText, digestKeyboard } from "./discovery/digest";
import { schedulerState, startScheduler, stopScheduler, nextRun } from "./discovery/scheduler";
import { SOURCE_CATALOG, getAdapters } from "./discovery/sources";
import { getUserSearchProfile } from "./discovery/profile";
import { findContacts, contactLine, type Contact } from "./actions/contacts";
import { draftOutreach, deliverOutreach, formatDraft, reviseOutreach } from "./actions/email";
import { draftFollowUps, dueFollowUps, pipelineText, weeklySummary } from "./actions/pipeline";
import {
  autoSendEnabled,
  isDryRun,
  isPaused,
  runtimeCron,
  runtimeMinFit,
  runtimeSources,
  runtimeTopN,
  setAutoSend,
  setDryRun,
  setPaused,
  setRuntimeCron,
  setRuntimeMinFit,
  setRuntimeTopN,
  setRuntimeSources,
} from "./runtime/settings";

const missing = requireSecrets();
if (missing.length) {
  console.error(`❌ Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const bot = new Bot(config.telegramToken);



bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (config.allowlist.length && (!userId || !config.allowlist.includes(userId))) {
    log.warn("auth.denied", { userId, chatId: ctx.chat?.id });
    if (ctx.chat && "reply" in ctx) {
      try {
        await ctx.reply("This bot is private.");
      } catch {
      }
    }
    return;
  }
  if (ctx.chat && ctx.from) ensureUser(ctx.chat.id, ctx.from.username);
  await next();
});

function chatIdOf(ctx: { chat?: { id: number }; from?: { id: number } }): number | null {
  return ctx.chat?.id ?? ctx.from?.id ?? null;
}

async function sendRaw(
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {},
  enqueueOnFailure = true
): Promise<boolean> {
  const chunks = chunkMessage(text);
  let ok = true;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    try {
      await withRetry(
        () =>
          bot.api.sendMessage(chatId, renderHtml(chunks[i]!), {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            ...(isLast ? extra : {}),
          } as never),
        { label: "send" }
      );
    } catch (error) {
      if (isParseError(error)) {
        try {
          await bot.api.sendMessage(chatId, plainFromHtml(renderHtml(chunks[i]!)), {
            link_preview_options: { is_disabled: true },
          });
          continue;
        } catch {
        }
      }
      ok = false;
      if (enqueueOnFailure) enqueueOutbox(chatId, "text", { text: chunks[i]! });
      log.warn("outbox.enqueued", { chatId, queued: enqueueOnFailure, error: String(error) });
    }
  }
  return ok;
}

async function sendDigest(chatId: number, result: DiscoveryResult) {
  const text = buildDigestText(result.scored, { errors: result.errors });
  const keyboard = digestKeyboard(result.scored);
  const chunks = chunkMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const payload = {
      parse_mode: "HTML" as const,
      link_preview_options: { is_disabled: true },
      ...(isLast ? { reply_markup: keyboard as never } : {}),
    };
    try {
      await withRetry(() => bot.api.sendMessage(chatId, renderHtml(chunks[i]!), payload as never), {
        label: "digest",
      });
    } catch (error) {
      if (!isParseError(error)) throw error;
      await bot.api.sendMessage(chatId, plainFromHtml(renderHtml(chunks[i]!)), {
        link_preview_options: { is_disabled: true },
        ...(isLast ? { reply_markup: keyboard as never } : {}),
      } as never);
    }
  }
}

async function downloadFile(fileId: string): Promise<Buffer> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file path");
  const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`File download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function startRun(chatId: number, kind: string): string {
  const runId = newRunId();
  try {
    insertRun(runId, chatId, kind);
  } catch (error) {
    log.warn("run.start_failed", { runId, ...serializeError(error) });
  }
  return runId;
}

function endRun(runId: string, status: string, summary?: string, error?: string) {
  try {
    finishRun(runId, status, summary, error);
  } catch (err) {
    log.warn("run.finish_failed", { runId, ...serializeError(err) });
  }
}

async function withProgress<T>(
  chatId: number,
  kind: string,
  title: string,
  fn: (reporter: ProgressReporter, runId: string) => Promise<{ value: T; summary?: string }>
): Promise<T> {
  const runId = startRun(chatId, kind);
  const reporter = new ProgressReporter(bot.api, chatId, title);
  await reporter.start();
  try {
    const { value, summary } = await fn(reporter, runId);
    endRun(runId, "ok", summary);
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    endRun(runId, "error", undefined, message);
    await reporter.fail(message);
    log.error(`${kind}.failed`, { chatId, runId, ...serializeError(error) });
    throw error;
  }
}

async function dailyDiscovery(chatId: number) {
  const reporter = new ProgressReporter(bot.api, chatId, "Morning discovery");
  await reporter.start();
  const runId = startRun(chatId, "cron");
  try {
    const result = await runDiscovery({ chatId, reporter });
    const summary = `${result.scanned} scanned · ${result.inserted} new · ${result.errors.length} errors`;
    endRun(runId, "ok", summary);
    await reporter.finish(`Morning sweep: ${summary}. Digest below.`);
    await sendDigest(chatId, result);

    const due = dueFollowUps(chatId);
    if (due.length) {
      await sendRaw(chatId, `${due.length} follow-up${due.length === 1 ? "" : "s"} due. /followups draft.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    endRun(runId, "error", undefined, message);
    await reporter.fail(`Morning sweep failed: ${message}`);
  }
}

async function sendDraft(chatId: number, outreachId: number) {
  const outreach = getOutreach(chatId, outreachId);
  if (!outreach) throw new Error(`Draft #${outreachId} not found`);
  const opp = outreach.opportunity_id ? getOpportunity(chatId, outreach.opportunity_id) : null;
  const keyboard = new InlineKeyboard()
    .text("Send", `out:send:${outreach.id}`)
    .text("Edit", `out:edit:${outreach.id}`);
  if (opp?.url) keyboard.url("Open", opp.url);
  await sendRaw(chatId, formatDraft(outreach, opp), { reply_markup: keyboard });
}

async function sendDraftCard(chatId: number, outreachId: number) {
  const outreach = getOutreach(chatId, outreachId);
  if (!outreach) return;
  const keyboard = new InlineKeyboard()
    .text("Send", `out:send:${outreach.id}`)
    .text("Edit", `out:edit:${outreach.id}`);
  await sendRaw(
    chatId,
    `**Draft #${outreach.id} ready** — ${outreach.subject}\nTo: ${outreach.to_email}`,
    { reply_markup: keyboard }
  );
}

async function sendRunDraftCards(chatId: number, runId: string) {
  for (const draft of listOutreachByRun(chatId, runId)) {
    await sendDraftCard(chatId, draft.id);
  }
}

function jobsText(chatId: number): string {
  const rows = listOpportunities(chatId, { limit: 10 });
  if (!rows.length) return "No opportunities yet. Run /discover.";
  const lines = ["**Opportunities**", ""];
  for (const o of rows) {
    const score = o.score ? ` · ${Math.round(o.score)}/100` : "";
    lines.push(`**${o.company}** — ${o.role}${score}`);
    const detail = [o.funding_event ?? o.why, o.status, o.source].filter(Boolean).join(" · ");
    if (detail) lines.push(detail);
    lines.push(`[Open](${o.url})`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function statusText(chatId: number): string {
  const state = schedulerState();
  const stats = memoryStats(chatId);
  const feedback = feedbackCounts(chatId);
  const facts = listFacts(chatId).length;
  const sources = runtimeSources();
  const enabledSources =
    sources.length === 0 ? "all" : sources.includes("__none__") ? "none" : sources.join(", ");
  const runs = db
    .query("SELECT id, kind, status, started_at FROM runs WHERE chat_id = ? ORDER BY started_at DESC LIMIT 3")
    .all(chatId) as { id: string; kind: string; status: string; started_at: string }[];

  return [
    "**Status**",
    `Telegram ID: ${chatId}`,
    `Schedule: ${state.cron} ${config.timezone} · ${state.paused ? "paused" : "active"}`,
    `Next: ${state.nextRunAt ? new Date(state.nextRunAt).toLocaleString("en-IN", { timeZone: config.timezone }) : "not armed"}`,
    `Memory: ${stats.chunks} chunks · ${facts} facts`,
    `Feedback: up ${feedback.up} · down ${feedback.down}`,
    `Sources: ${enabledSources}`,
    `Fit ${runtimeMinFit()} · digest ${runtimeTopN()} · email ${isDryRun() ? "dry" : "live"}`,
    `Auto-send: ${autoSendEnabled() ? "on" : "off"}`,
    "",
    "**Recent runs**",
    ...(runs.length ? runs.map((r) => `- ${r.kind} ${r.status} · ${r.id}`) : ["- none"]),
  ].join("\n");
}

function settingsText(): string {
  return [
    "**Settings**",
    `Model: ${config.opencode.model}`,
    `Timezone: ${config.timezone}`,
    `Cron: ${runtimeCron()}`,
    `Min fit: ${runtimeMinFit()} · digest ${runtimeTopN()}`,
    `DRY_RUN: ${isDryRun() ? "on" : "off"} · auto-send: ${autoSendEnabled() ? "on" : "off"}`,
    `Paused: ${isPaused() ? "yes" : "no"}`,
    "",
    "Set: /settings dryrun on|off · autosend on|off · minfit <n> · topn <n> · cron HH:MM",
  ].join("\n");
}

function createBackup(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(config.backupDir, `agent-${stamp}.db`);
  backupDb(target);
  const files = readdirSync(config.backupDir)
    .filter((f) => f.endsWith(".db"))
    .sort();
  while (files.length > 7) {
    const oldest = files.shift();
    if (oldest) rmSync(join(config.backupDir, oldest), { force: true });
  }
  return target;
}


bot.command("start", async (ctx) => {
  await sendRaw(
    ctx.chat.id,
    [
      "**Personal job-hunting agent**",
      "Tell me about yourself, send a resume, or run /discover.",
      "",
      "Try: _I'm a backend engineer, remote-only, seed-stage AI startups_",
      "",
      "/help for commands.",
    ].join("\n")
  );
});

bot.command("help", async (ctx) => {
  await sendRaw(
    ctx.chat.id,
    [
      "**Commands**",
      "**Discovery**: /discover · /jobs · /draft <id> · /send <id>",
      "**Pipeline**: /pipeline · /followups [draft] · /weekly",
      "**Memory**: /profile · /memory [search <q>] · /forget <topic>",
      "**Ops**: /status · /settings · /sources · /pause · /resume · /health · /logs · /backup",
      "**Chat**: /clear · /help",
    ].join("\n")
  );
});

bot.command("clear", async (ctx) => {
  clearSession(ctx.chat.id);
  await ctx.reply("Chat context cleared. Long-term memory is untouched.");
});

bot.command("profile", async (ctx) => {
  const derived = getUserSearchProfile(ctx.chat.id);
  const facts = listFacts(ctx.chat.id).slice(0, 8);
  const stats = memoryStats(ctx.chat.id);
  await sendRaw(
    ctx.chat.id,
    [
      "**Profile**",
      derived.summary || "Nothing learned yet.",
      "",
      "**Facts**",
      ...(facts.length ? facts.map((f) => `- [${f.kind}] ${f.key}: ${f.value}`) : ["- none"]),
      "",
      `Memory: ${stats.chunks} chunks`,
    ].join("\n")
  );
});

bot.command("jobs", async (ctx) => {
  await sendRaw(ctx.chat.id, jobsText(ctx.chat.id));
});

bot.command("discover", async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    await enqueue(chatId, () =>
      withProgress(chatId, "discover", "Discovery", async (reporter) => {
        const result = await runDiscovery({ chatId, reporter });
        await reporter.finish(`Sweep done. ${result.inserted} new of ${result.scanned} scanned.`);
        await sendDigest(chatId, result);
        return {
          value: result,
          summary: `${result.scanned} scanned · ${result.inserted} new · ${result.errors.length} errors`,
        };
      })
    );
  } catch {
  }
});

bot.command("draft", async (ctx) => {
  const [idRaw, email] = ctx.match.trim().split(/\s+/);
  const id = Number(idRaw);
  if (!Number.isFinite(id)) {
    await ctx.reply("Usage: /draft <opportunityId> [email]");
    return;
  }
  const opp = getOpportunity(ctx.chat.id, id);
  if (!opp) {
    await ctx.reply(`Opportunity #${id} not found. See /jobs.`);
    return;
  }
  try {
    await withProgress(ctx.chat.id, "draft", "Drafting outreach", async (reporter, runId) => {
      let contact: Contact | undefined = email ? { email, confidence: 1, source: "user" } : undefined;
      if (!contact) {
        const step = reporter.addStep("Finding a contact");
        const contacts = await findContacts(opp);
        reporter.completeStep(step, contacts[0] ? contactLine(contacts[0]) : "none");
        contact = contacts[0];
      }
      if (!contact) throw new Error("No contact email found — pass one: /draft <id> <email>");
      const outreach = await draftOutreach(ctx.chat.id, opp, contact, { runId });
      await reporter.finish("Draft ready below.");
      await sendDraft(ctx.chat.id, outreach.id);
      return { value: outreach, summary: `draft #${outreach.id}` };
    });
  } catch {
  }
});

bot.command("send", async (ctx) => {
  const id = Number(ctx.match.trim());
  if (!Number.isFinite(id)) {
    await ctx.reply("Usage: /send <outreachId>");
    return;
  }
  try {
    const result = await deliverOutreach(ctx.chat.id, id);
    if (result.sent) {
      await ctx.reply(`Sent #${id} to ${result.outreach.to_email}.`);
    } else {
      await sendRaw(
        ctx.chat.id,
        `Not sent: ${result.reason ?? "unknown reason"}\n\n${formatDraft(result.outreach)}`
      );
    }
  } catch (error) {
    await ctx.reply(`Could not send #${id}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
});

bot.command("pipeline", async (ctx) => {
  await sendRaw(ctx.chat.id, pipelineText(ctx.chat.id));
});

bot.command("followups", async (ctx) => {
  const action = ctx.match.trim();
  if (action === "draft") {
    try {
      await withProgress(ctx.chat.id, "followups", "Drafting follow-ups", async (reporter) => {
        const drafts = await draftFollowUps(ctx.chat.id);
        await reporter.finish(drafts.length ? `${drafts.length} follow-up drafts.` : "No follow-ups due.");
        for (const draft of drafts) await sendDraft(ctx.chat.id, draft.id);
        return { value: drafts, summary: `${drafts.length} drafts` };
      });
    } catch {
    }
    return;
  }
  const due = dueFollowUps(ctx.chat.id);
  await sendRaw(
    ctx.chat.id,
    due.length
      ? ["**Follow-ups due**", ...due.map((d) => `• #${d.id} ${d.to_email} — ${d.subject}`), "", "Draft them with /followups draft"].join("\n")
      : "No follow-ups due."
  );
});

bot.command("memory", async (ctx) => {
  const arg = ctx.match.trim();
  if (arg.startsWith("search ")) {
    const query = arg.slice(7).trim();
    const results = recall(ctx.chat.id, query, 8);
    await sendRaw(
      ctx.chat.id,
      results.length
        ? ["**Memory search**", "", ...results.map((r) => `• (${r.score.toFixed(2)}) ${r.source}: ${r.text.slice(0, 300)}`)].join("\n")
        : "No matching memories."
    );
    return;
  }
  const stats = memoryStats(ctx.chat.id);
  const facts = listFacts(ctx.chat.id);
  await sendRaw(
    ctx.chat.id,
    [
      "**Memory**",
      `• ${stats.chunks} chunks across ${Object.keys(stats.sources).length} sources`,
      `• ${facts.length} stored facts`,
      `• chat session: ${sessionSize(ctx.chat.id)} messages`,
      "",
      "Search with /memory search <query>",
    ].join("\n")
  );
});

bot.command("weekly", async (ctx) => {
  await sendRaw(ctx.chat.id, weeklySummary(ctx.chat.id));
});

bot.command("status", async (ctx) => {
  await sendRaw(ctx.chat.id, statusText(ctx.chat.id));
});

bot.command("settings", async (ctx) => {
  const arg = ctx.match.trim();
  const [key, ...rest] = arg.split(/\s+/);
  const value = rest.join(" ").trim();
  switch (key) {
    case "":
      await sendRaw(ctx.chat.id, settingsText());
      return;
    case "dryrun":
      if (!["on", "off"].includes(value)) break;
      setDryRun(value === "on");
      await ctx.reply(`DRY_RUN is now ${value}.`);
      return;
    case "autosend":
      if (!["on", "off"].includes(value)) break;
      setAutoSend(value === "on");
      await ctx.reply(`Auto-send is now ${value}.`);
      return;
    case "minfit": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 100) break;
      setRuntimeMinFit(n);
      await ctx.reply(`Minimum fit score set to ${n}.`);
      return;
    }
    case "topn": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1) break;
      setRuntimeTopN(n);
      await ctx.reply(`Digest size set to ${Math.min(n, 20)}.`);
      return;
    }
    case "cron": {
      const match = value.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) break;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour > 23 || minute > 59) break;
      setRuntimeCron(`${minute} ${hour} * * *`);
      stopScheduler();
      startScheduler(dailyDiscovery);
      await ctx.reply(`Daily discovery set to ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${config.timezone}.`);
      return;
    }
  }
  await ctx.reply("Usage: /settings dryrun on|off · autosend on|off · minfit <n> · topn <n> · cron HH:MM");
});

bot.command("sources", async (ctx) => {
  const arg = ctx.match.trim();
  const current = runtimeSources();
  const allNames = SOURCE_CATALOG.map((s) => s.name);
  const enabled = new Set(current.length === 0 ? allNames : current.includes("__none__") ? [] : current);

  if (arg === "all") {
    setSetting("sources", "");
    await ctx.reply("All sources enabled.");
  } else if (arg.startsWith("toggle ")) {
    const name = arg.slice(7).trim();
    if (!allNames.includes(name)) {
      await ctx.reply(`Unknown source. Options: ${allNames.join(", ")}`);
      return;
    }
    if (enabled.has(name)) enabled.delete(name);
    else enabled.add(name);
    setRuntimeSources(enabled.size ? [...enabled] : []);
    await ctx.reply(`${name} ${enabled.has(name) ? "enabled" : "disabled"}.`);
  }

  const lines = ["**Sources**", ""];
  for (const source of SOURCE_CATALOG) {
    lines.push(`${enabled.has(source.name) ? "on" : "off"} ${source.label} (${source.name})`);
  }
  lines.push("", "Toggle with /sources toggle <name> · enable all with /sources all");
  await sendRaw(ctx.chat.id, lines.join("\n"));
});

bot.command("pause", async (ctx) => {
  setPaused(true);
  await ctx.reply("Paused. /resume to restart.");
});

bot.command("resume", async (ctx) => {
  setPaused(false);
  await ctx.reply("Resumed.");
});

bot.command("forget", async (ctx) => {
  const topic = ctx.match.trim();
  if (!topic) {
    await ctx.reply("Usage: /forget <topic>");
    return;
  }
  const { deleteFacts } = await import("./memory/db");
  const removed = deleteFacts(ctx.chat.id, topic);
  await ctx.reply(`Forgot ${removed} matching fact(s) and related memory chunks.`);
});

bot.command("backup", async (ctx) => {
  try {
    const path = createBackup();
    await ctx.reply(`Backup created: ${path}`);
  } catch (error) {
    await ctx.reply(`Backup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
});

bot.command("logs", async (ctx) => {
  const runId = ctx.match.trim();
  if (runId) {
    const run = getRun(runId);
    if (!run) {
      await ctx.reply(`Run ${runId} not found.`);
      return;
    }
    await sendRaw(
      ctx.chat.id,
      [
        `**${run.id}**`,
        `kind: ${run.kind} · status: ${run.status}`,
        `started: ${run.started_at}`,
        `finished: ${run.finished_at ?? "-"}`,
        run.summary ? `summary: ${run.summary}` : "",
        run.error ? `error: ${run.error}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
    return;
  }
  const rows = db
    .query("SELECT id, kind, status, started_at FROM runs ORDER BY started_at DESC LIMIT 10")
    .all() as { id: string; kind: string; status: string; started_at: string }[];
  await sendRaw(
    ctx.chat.id,
    ["**Recent runs**", ...(rows.length ? rows.map((r) => `• ${r.kind} ${r.status} — ${r.id} (${r.started_at})`) : ["• none"])].join("\n")
  );
});

bot.command("health", async (ctx) => {
  let dbOk = true;
  try {
    db.query("SELECT 1").get();
  } catch {
    dbOk = false;
  }
  const state = schedulerState();
  const stats = memoryStats(ctx.chat.id);
  const stt = whisperCppStatus();
  await sendRaw(
    ctx.chat.id,
    [
      "**Health**",
      `- database: ${dbOk ? "ok" : "error"}`,
      `- AI key: ${config.opencode.apiKey ? "configured" : "missing"}`,
      `- model: ${config.opencode.model}`,
      `- scheduler: ${state.nextRunAt ?? "not armed"}`,
      `- paused: ${isPaused() ? "yes" : "no"}`,
      `- memory: ${stats.chunks} chunks`,
      `- email: ${isDryRun() ? "dry run" : "live"}`,
      `- STT: ${stt.available ? `${config.stt.provider} (${stt.model.split("/").pop()})` : stt.reason}`,
      `- Resend: ${config.email.resendApiKey ? "configured" : "missing"}`,
    ].join("\n")
  );
});


const pendingEdits = new Map<number, number>();

async function handleText(chatId: number, text: string, extraPrefix = "", imageDataUrl?: string) {
  const runId = startRun(chatId, "chat");
  const reporter = new ProgressReporter(bot.api, chatId, "Working…");
  await reporter.start();
  try {
    const answer = await runAgent({ chatId, text, reporter, runId, imageDataUrl });
    endRun(runId, "ok", `${answer.length} chars`);
    ingestMemory(chatId, "conversation", `User: ${text}\nAgent: ${answer.slice(0, 1500)}`);
    await reporter.finish(`${extraPrefix}${answer}`);
    await sendRunDraftCards(chatId, runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    endRun(runId, "error", undefined, message);
    await reporter.fail(`Error: ${message}`);
    log.error("chat.failed", { chatId, runId, ...serializeError(error) });
  }
}

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    await ctx.reply("Unknown command. Use /help for the list.");
    return;
  }

  const chatId = ctx.chat.id;

  const editId = pendingEdits.get(chatId);
  if (editId !== undefined) {
    pendingEdits.delete(chatId);
    try {
      await withProgress(chatId, "revise", "Revising draft", async (reporter) => {
        const outreach = await reviseOutreach(chatId, editId, text);
        await reporter.finish("Draft revised below.");
        await sendDraft(chatId, outreach.id);
        return { value: outreach, summary: `revised #${outreach.id}` };
      });
    } catch {
    }
    return;
  }

  const forwarded = ctx.message.forward_origin ? "Forwarded message.\n\n" : "";
  await enqueue(chatId, () => handleText(chatId, text, forwarded));
});

bot.on("message:voice", async (ctx) => {
  const chatId = ctx.chat.id;
  const runId = startRun(chatId, "voice");
  const reporter = new ProgressReporter(bot.api, chatId, "Processing voice note");
  await reporter.start();
  try {
    const dl = reporter.addStep("Downloading audio");
    const buffer = await downloadFile(ctx.message.voice.file_id);
    reporter.completeStep(dl);

    const tr = reporter.addStep("Transcribing");
    const transcript = await transcribeAudio(new Blob([new Uint8Array(buffer)]), "voice.ogg");
    reporter.completeStep(tr, `${transcript.length} chars`);
    if (!transcript.trim()) throw new Error("Transcription was empty");

    reporter.note(`Heard: "${transcript.slice(0, 140)}${transcript.length > 140 ? "…" : ""}"`);
    const answer = await runAgent({ chatId, text: transcript, reporter, runId });
    endRun(runId, "ok", `${answer.length} chars`);
    ingestMemory(chatId, "conversation", `User (voice): ${transcript}\nAgent: ${answer.slice(0, 1500)}`);
    await reporter.finish(`Heard: "${transcript.slice(0, 300)}"\n\n${answer}`);
    await sendRunDraftCards(chatId, runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    endRun(runId, "error", undefined, message);
    await reporter.fail(
      `Could not process the voice note: ${message}\n\nTip: install whisper.cpp + models/ggml-base.en.bin (bun run check verifies it), or set STT_PROVIDER=auto with an API key. You can also send text.`
    );
  }
});

bot.on("message:audio", async (ctx) => {
  const chatId = ctx.chat.id;
  const runId = startRun(chatId, "audio");
  const reporter = new ProgressReporter(bot.api, chatId, "Processing audio");
  await reporter.start();
  try {
    const buffer = await downloadFile(ctx.message.audio.file_id);
    const transcript = await transcribeAudio(new Blob([new Uint8Array(buffer)]), ctx.message.audio.file_name ?? "audio.mp3");
    reporter.note(`Heard: "${transcript.slice(0, 140)}"`);
    const answer = await runAgent({ chatId, text: transcript || "Audio file transcript", reporter, runId });
    endRun(runId, "ok", `${answer.length} chars`);
    await reporter.finish(answer);
    await sendRunDraftCards(chatId, runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    endRun(runId, "error", undefined, message);
    await reporter.fail(`Could not process audio: ${message}`);
  }
});

bot.on("message:document", async (ctx) => {
  const chatId = ctx.chat.id;
  const doc = ctx.message.document;
  if ((doc.file_size ?? 0) > 20 * 1024 * 1024) {
    await ctx.reply("File is over Telegram's 20 MB bot limit. Send a smaller version.");
    return;
  }
  const runId = startRun(chatId, "document");
  const reporter = new ProgressReporter(bot.api, chatId, `Reading ${doc.file_name ?? "document"}`);
  await reporter.start();
  try {
    const dl = reporter.addStep("Downloading file");
    const buffer = await downloadFile(doc.file_id);
    reporter.completeStep(dl);

    const ex = reporter.addStep("Extracting text");
    const extracted = await extractDocument(buffer, doc.file_name, doc.mime_type);
    if (!extracted.text.trim()) throw new Error("No readable text found in this file");
    reporter.completeStep(ex, `${extracted.text.length} chars`);

    const ing = reporter.addStep("Saving to memory");
    const result = ingestDocument(chatId, doc.file_name ?? "document", doc.mime_type ?? null, extracted.text);
    reporter.completeStep(ing, `${result.chunks} chunks`);

    const prompt = [
      `I uploaded "${doc.file_name ?? "document"}" (${extracted.format}${extracted.pages ? `, ${extracted.pages} pages` : ""}).`,
      "I stored the full text in your memory. Here is the extracted content:",
      "",
      extracted.text.slice(0, 6000),
      extracted.text.length > 6000 ? "\n[truncated — the rest is in memory]" : "",
      "",
      "Acknowledge what this is, and if it's my resume, update my profile with the key facts.",
    ].join("\n");

    const answer = await runAgent({ chatId, text: prompt, reporter, runId });
    endRun(runId, "ok", `${result.chunks} chunks`);
    await reporter.finish(answer);
    await sendRunDraftCards(chatId, runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    endRun(runId, "error", undefined, message);
    await reporter.fail(`Could not read that document: ${message}`);
  }
});

bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id;
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  if (!photo) return;
  const runId = startRun(chatId, "photo");
  const reporter = new ProgressReporter(bot.api, chatId, "Reading screenshot");
  await reporter.start();
  try {
    const buffer = await downloadFile(photo.file_id);
    const dataUrl = `data:image/jpeg;base64,${buffer.toString("base64")}`;
    const caption = ctx.message.caption ?? "";
    const answer = await runAgent({
      chatId,
      text: caption || "Look at this screenshot. If it's a job listing, extract the company, role, and any contact details.",
      reporter,
      runId,
      imageDataUrl: dataUrl,
    });
    endRun(runId, "ok", `${answer.length} chars`);
    await reporter.finish(answer);
    await sendRunDraftCards(chatId, runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    endRun(runId, "error", undefined, message);
    await reporter.fail(
      `I couldn't read that image: ${message}\n\nIf the model doesn't support images, send the text or a PDF instead.`
    );
  }
});


bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = chatIdOf(ctx);
  if (!chatId) {
    await ctx.answerCallbackQuery({ text: "Unsupported context" });
    return;
  }
  const [ns, action, rawId] = data.split(":");
  const id = Number(rawId);

  try {
    if (ns === "fb" && (action === "up" || action === "down") && Number.isFinite(id)) {
      addFeedback(chatId, id, action);
      setOpportunityStatus(chatId, id, action === "up" ? "shortlisted" : "skipped");
      addPipelineEvent(chatId, id, `feedback_${action}`);
      await ctx.answerCallbackQuery({ text: action === "up" ? "Noted up" : "Noted down" });
      return;
    }

    if (ns === "opp" && Number.isFinite(id)) {
      const opp = getOpportunity(chatId, id);
      if (!opp) {
        await ctx.answerCallbackQuery({ text: "Opportunity not found" });
        return;
      }
      if (action === "save") {
        setOpportunityStatus(chatId, id, "shortlisted");
        addPipelineEvent(chatId, id, "shortlisted", "saved from digest");
        await ctx.answerCallbackQuery({ text: "Saved" });
        return;
      }
      if (action === "skip") {
        setOpportunityStatus(chatId, id, "skipped");
        await ctx.answerCallbackQuery({ text: "Skipped" });
        return;
      }
      if (action === "draft") {
        await ctx.answerCallbackQuery({ text: "Drafting…" });
        try {
          await withProgress(chatId, "draft", "Drafting outreach", async (reporter, runId) => {
            const step = reporter.addStep("Finding a contact");
            const contacts = await findContacts(opp);
            reporter.completeStep(step, contacts[0] ? contactLine(contacts[0]) : "none");
            const contact = contacts[0];
            if (!contact) throw new Error("No contact email found. Use /draft <id> <email>.");
            const outreach = await draftOutreach(chatId, opp, contact, { runId });
            await reporter.finish("Draft ready below.");
            await sendDraft(chatId, outreach.id);
            return { value: outreach, summary: `draft #${outreach.id}` };
          });
        } catch {
        }
        return;
      }
    }

    if (ns === "out" && Number.isFinite(id)) {
      if (action === "send") {
        await ctx.answerCallbackQuery({ text: "Sending…" });
        const result = await deliverOutreach(chatId, id);
        if (result.sent) {
          await sendRaw(chatId, `Sent #${id} to ${result.outreach.to_email}.`);
        } else {
          await sendRaw(chatId, `Not sent: ${result.reason ?? "unknown reason"}\n\n${formatDraft(result.outreach)}`);
        }
        return;
      }
      if (action === "edit") {
        pendingEdits.set(chatId, id);
        await ctx.answerCallbackQuery({ text: "Send me the change" });
        await sendRaw(chatId, `Tell me how to change draft #${id} (e.g. "make it shorter", "mention their funding").`);
        return;
      }
    }

    if (ns === "src") {
      await ctx.answerCallbackQuery({ text: "Use /sources toggle <name>" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Unsupported action" });
  } catch (error) {
    log.error("callback.failed", { data, ...serializeError(error) });
    await ctx.answerCallbackQuery({ text: `Error: ${error instanceof Error ? error.message : "unknown"}` }).catch(() => {});
  }
});


bot.catch((error) => {
  log.error("bot.error", serializeError(error.error));
});

async function flushOutbox() {
  const pending = listPendingOutbox();
  for (const item of pending) {
    try {
      const payload = JSON.parse(item.payload) as { text?: string };
      if (!payload.text) {
        markOutboxFailed(item.id, "empty payload");
        continue;
      }
      const ok = await sendRaw(item.chat_id, payload.text, {}, false);
      if (ok) markOutboxSent(item.id);
      else markOutboxFailed(item.id, "send failed");
    } catch (error) {
      markOutboxFailed(item.id, error instanceof Error ? error.message : String(error));
    }
  }
}

async function main() {
  log.info("bot.starting", {
    model: config.opencode.model,
    timezone: config.timezone,
    dryRun: isDryRun(),
    sources: runtimeSources().length ? runtimeSources().join(",") : "all",
  });

  if (!config.allowlist.length) {
    log.warn("auth.allowlist_empty", {
      note: "Anyone who finds this bot can use it and read its memory. Set ALLOWED_USER_IDS.",
    });
    console.warn("⚠️  ALLOWED_USER_IDS is empty — this bot is open to anyone who finds it.");
  }

  if (/\/Desktop\/|\/Documents\/|Mobile Documents|iCloud/i.test(config.dataDir)) {
    log.warn("storage.synced_path", {
      dataDir: config.dataDir,
      note: "SQLite under a synced folder can throw SQLITE_IOERR_VNODE. Set DATA_DIR=$HOME/.job-agent-bot.",
    });
    console.warn("⚠️  data/ is under a cloud-synced folder — set DATA_DIR=$HOME/.job-agent-bot if you see disk I/O errors.");
  }

  try {
    await bot.api.setMyCommands(BOT_COMMANDS);
    log.info("bot.commands_registered", { count: BOT_COMMANDS.length });
  } catch (error) {
    log.warn("bot.commands_register_failed", serializeError(error));
  }

  try {
    const backup = createBackup();
    log.info("backup.created", { backup });
  } catch (error) {
    log.warn("backup.failed", serializeError(error));
  }

  await flushOutbox();

  startScheduler(dailyDiscovery);
  log.info("scheduler.armed", schedulerState());

  setInterval(() => {
    try {
      const path = createBackup();
      log.info("backup.scheduled", { path });
    } catch (error) {
      log.warn("backup.scheduled_failed", serializeError(error));
    }
  }, 12 * 60 * 60 * 1000);

  await bot.start({
    onStart: (botInfo) => {
      log.info("bot.ready", { username: `@${botInfo.username}`, id: botInfo.id });
      console.log("");
      console.log("=================================");
      console.log(`✅ TELEGRAM BOT IS RUNNING: @${botInfo.username}`);
      console.log(`🧠 Model: ${config.opencode.model}`);
      console.log(`🌅 Discovery: ${runtimeCron()} (${config.timezone})`);
      console.log(`🧪 DRY_RUN: ${isDryRun() ? "on" : "off"}`);
      const stt = whisperCppStatus();
      console.log(`🎙 STT: ${stt.available ? `whisper.cpp ${stt.model.split("/").pop()}` : `unavailable (${stt.reason})`}`);
      console.log("=================================");
    },
  });
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("bot.shutdown", { signal });
  stopScheduler();
  try {
    await bot.stop();
  } catch {
  }
  try {
    db.close();
  } catch {
  }
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

async function checkStartup() {
  db.query("SELECT 1").get();
  const me = await bot.api.getMe();
  const sources = runtimeSources();
  const adapters = sources.includes("__none__") ? [] : getAdapters(sources);
  const next = nextRun(runtimeCron());
  const whisper = whisperCppStatus();
  console.log(
    JSON.stringify(
      {
        ok: true,
        bot: `@${me.username}`,
        model: config.opencode.model,
        timezone: config.timezone,
        nextDiscoveryRun: next.toISOString(),
        sources: adapters.map((a) => a.name),
        database: config.dbPath,
        dryRun: isDryRun(),
        stt: {
          provider: config.stt.provider,
          whisper: whisper.available ? "ready" : whisper.reason,
          model: whisper.model.split("/").pop(),
        },
        allowlist: config.allowlist.length,
      },
      null,
      2
    )
  );
}

if (process.argv.includes("--check")) {
  checkStartup()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`❌ Check failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
} else {
  main().catch((error) => {
    log.error("bot.fatal", serializeError(error));
    console.error(error);
    process.exit(1);
  });
}
