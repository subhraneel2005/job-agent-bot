import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "job-agent-test-"));
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.OPENCODE_API_KEY = "test-key";
process.env.TZ = "Asia/Kolkata";

const { chunkMessage, renderHtml, escapeHtml } = await import("../telegram/format");
const { embed, cosine, chunkText } = await import("../memory/rag");
const { db, setProfile, upsertOpportunity, getOpportunity, addFact, listFacts } = await import("../memory/db");
const { nextRun, parseCron } = await import("../discovery/scheduler");
const { csvToText } = await import("../ingest/extract");
const { heuristicScore } = await import("../discovery/score");
const { buildDigestText, digestKeyboard } = await import("../discovery/digest");
const { cleanTranscript } = await import("../stt/whispercpp");
const { BOT_COMMANDS } = await import("../telegram/commands");
const { ProgressReporter } = await import("../telegram/progress");

test("chunkMessage respects the Telegram limit and preserves order", () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const chunks = chunkMessage(text);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096);
  expect(chunks.join("\n").replace(/\s+/g, " ")).toContain("line 399");
});

test("renderHtml escapes markup and renders bold, code, links", () => {
  const html = renderHtml("**hi** `x<y` [site](https://example.com) <script>alert(1)</script>");
  expect(html).toContain("<b>hi</b>");
  expect(html).toContain("<code>x&lt;y</code>");
  expect(html).toContain('<a href="https://example.com">site</a>');
  expect(html).not.toContain("<script>");
  expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
});

test("renderHtml converts a job card to Telegram HTML", () => {
  const md = `## Job Found

**Company:** Superagent
**Role:** AI Engineer

- Remote
- TypeScript
- Agents

[Apply →](https://example.com/jobs/1)`;
  expect(renderHtml(md)).toBe(
    `<b>Job Found</b>

<b>Company:</b> Superagent
<b>Role:</b> AI Engineer

• Remote
• TypeScript
• Agents

<a href="https://example.com/jobs/1">Apply →</a>`
  );
});

test("renderHtml converts headings, bullets, quotes and tables", () => {
  const html = renderHtml("# Title\n\n- one\n- two\n\n> quoted\n\n| A | B |\n|---|---|\n| x | y |");
  expect(html).toContain("<b>Title</b>");
  expect(html).not.toContain("# Title");
  expect(html).toContain("• one");
  expect(html).toContain("• two");
  expect(html).toContain("<blockquote>");
  expect(html).toContain("quoted");
  expect(html).toContain("A · B");
  expect(html).toContain("x · y");
  expect(html).not.toContain("|---|");
});

test("renderHtml keeps at most one emoji", () => {
  const html = renderHtml("ok 😀 done 🚀");
  expect((html.match(/\p{Extended_Pictographic}/gu) ?? []).length).toBe(1);
});

test("code fences are preserved and not styled as markdown", () => {
  const html = renderHtml("```ts\nconst x = '*not italic*';\n```");
  expect(html).toContain("<pre>");
  expect(html).toContain("const x");
  expect(html).not.toContain("<i>");
});

test("embeddings reward lexical overlap", () => {
  const a = embed("senior typescript backend engineer remote fintech");
  const b = embed("backend engineer typescript remote");
  const c = embed("pastry chef sourdough bakery");
  expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
});

test("chunkText covers the document with overlap", () => {
  const text = "Sentence number one. ".repeat(200);
  const chunks = chunkText(text);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(900);
  expect(chunks.join(" ")).toContain("Sentence number one.");
});

test("cron parser computes the next 8:00 in the configured timezone", () => {
  expect(parseCron("0 8 * * *")).toEqual({ minute: 0, hour: 8, dom: null, month: null, dow: null });
  const next = nextRun("0 8 * * *", new Date("2026-11-16T02:00:00Z"));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(next);
  const hour = parts.find((p) => p.type === "hour")?.value;
  const minute = parts.find((p) => p.type === "minute")?.value;
  expect(`${hour}:${minute}`).toBe("08:00");
});

test("csvToText turns rows into readable lines", () => {
  const out = csvToText("name,role\nAda,engineer\nGrace,admiral\n");
  expect(out).toContain("name: Ada | role: engineer");
  expect(out).toContain("name: Grace | role: admiral");
});

test("opportunities dedupe on company + role + url", () => {
  const chatId = 999001;
  const first = upsertOpportunity(chatId, {
    company: "Acme",
    role: "Backend Engineer",
    url: "https://acme.test/jobs/1",
    source: "test",
    hiring: true,
  });
  const second = upsertOpportunity(chatId, {
    company: "Acme",
    role: "Backend Engineer",
    url: "https://acme.test/jobs/1",
    source: "test",
  });
  expect(first?.inserted).toBe(true);
  expect(second?.inserted).toBe(false);
  expect(second?.id).toBe(first?.id);
  expect(getOpportunity(chatId, first!.id)?.company).toBe("Acme");
});

test("facts are stored and searchable", () => {
  const chatId = 999002;
  addFact(chatId, "preference", "remote", "remote only");
  addFact(chatId, "skill", "language", "typescript");
  expect(listFacts(chatId).length).toBe(2);
  expect(listFacts(chatId, "skill")[0]?.value).toBe("typescript");
});

test("heuristic scoring prefers matching skills", () => {
  const chatId = 999003;
  setProfile(chatId, { skills: ["typescript", "react"], roles: ["engineer"], industries: ["developer tools"] });
  const matching = upsertOpportunity(chatId, {
    company: "MatchCo",
    role: "Senior Engineer",
    url: "https://match.test/1",
    source: "yc",
    hiring: true,
    fundingEvent: "raised $5M seed",
    why: "typescript react developer tools engineer",
  })!;
  const unrelated = upsertOpportunity(chatId, {
    company: "Bakery",
    role: "Pastry Chef",
    url: "https://bakery.test/1",
    source: "github",
    hiring: false,
    why: "sourdough and croissants",
  })!;
  const a = heuristicScore(chatId, getOpportunity(chatId, matching.id)!);
  const b = heuristicScore(chatId, getOpportunity(chatId, unrelated.id)!);
  expect(a.score).toBeGreaterThan(b.score);
});

test("digest text and keyboard include each opportunity", () => {
  const chatId = 999004;
  const opp = upsertOpportunity(chatId, {
    company: "DigestCo",
    role: "Platform Engineer",
    url: "https://digest.test/jobs/1",
    source: "yc",
    hiring: true,
    why: "recent YC batch",
  })!;
  const row = getOpportunity(chatId, opp.id)!;
  const scored = [{ opportunity: row, score: 88, rationale: "typescript match" }];
  const text = buildDigestText(scored);
  expect(text).toContain("DigestCo");
  expect(text).toContain("88/100");
  const keyboard = digestKeyboard(scored);
  const callbacks = keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  expect(callbacks).toContain(`opp:draft:${opp.id}`);
});

test("database responds to health query", () => {
  expect(db.query("SELECT 1 as ok").get()).toEqual({ ok: 1 });
});

test("cleanTranscript removes whisper silence markers", () => {
  expect(cleanTranscript("[BLANK_AUDIO] hello (music) world [MUSIC] (applause)")).toBe(
    "hello world"
  );
});

test("db reopens and recreates schema if the file disappears", async () => {
  const { unlinkSync } = await import("node:fs");
  const { config } = await import("../config");
  db.query("SELECT 1").get();
  unlinkSync(config.dbPath);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      unlinkSync(`${config.dbPath}${suffix}`);
    } catch {
    }
  }
  expect(() => db.query("SELECT 1 as ok").get()).not.toThrow();
  expect(db.query("SELECT 1 as ok").get()).toEqual({ ok: 1 });
});

test("bot commands are valid for Telegram's command menu", () => {
  expect(BOT_COMMANDS.length).toBeLessThanOrEqual(100);
  expect(new Set(BOT_COMMANDS.map((c) => c.command)).size).toBe(BOT_COMMANDS.length);
  for (const command of BOT_COMMANDS) {
    expect(command.command).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(command.description.length).toBeGreaterThan(0);
    expect(command.description.length).toBeLessThanOrEqual(256);
  }
});

test("progress reporter sends HTML once, never escaped tags", async () => {
  const calls: { text: string; parse?: string }[] = [];
  const api = {
    sendMessage: async (_chatId: number, text: string, opts?: { parse_mode?: string }) => {
      calls.push({ text, parse: opts?.parse_mode });
      return { message_id: 1 };
    },
    editMessageText: async (
      _chatId: number,
      _messageId: number,
      text: string,
      opts?: { parse_mode?: string }
    ) => {
      calls.push({ text, parse: opts?.parse_mode });
      return true;
    },
    sendChatAction: async () => true,
  };
  const reporter = new ProgressReporter(api as never, 1, "Test");
  await reporter.start();
  await reporter.finish("## Done\n\n**Bold**");
  expect(calls[0]?.text).toContain("<b>Test</b>");
  expect(calls[0]?.text).not.toContain("&lt;b&gt;");
  expect(calls[1]?.text).toContain("<b>Done</b>");
  expect(calls[1]?.text).not.toContain("&lt;b&gt;");
  expect(calls.every((call) => call.parse === "HTML")).toBe(true);
});
