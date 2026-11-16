import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config";
import { log } from "../logger";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  chat_id     INTEGER PRIMARY KEY,
  username    TEXT,
  profile     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS facts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  source      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_facts_chat ON facts(chat_id, kind);

CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  filename    TEXT NOT NULL,
  mime        TEXT,
  text        TEXT NOT NULL,
  chars       INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER,
  chat_id     INTEGER NOT NULL,
  source      TEXT NOT NULL,
  text        TEXT NOT NULL,
  embedding   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunks_chat ON chunks(chat_id);

CREATE TABLE IF NOT EXISTS opportunities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  company       TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'unknown',
  url           TEXT NOT NULL,
  source        TEXT NOT NULL,
  stage         TEXT,
  funding_event TEXT,
  funding_date  TEXT,
  launch_date   TEXT,
  hiring        INTEGER NOT NULL DEFAULT 0,
  why           TEXT,
  raw           TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  signal_date   TEXT,
  score         REAL,
  rationale     TEXT,
  status        TEXT NOT NULL DEFAULT 'new',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chat_id, company, role, url)
);
CREATE INDEX IF NOT EXISTS idx_opp_chat_status ON opportunities(chat_id, status);

CREATE TABLE IF NOT EXISTS feedback (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id        INTEGER NOT NULL,
  opportunity_id INTEGER NOT NULL,
  signal         TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS outreach (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id        INTEGER NOT NULL,
  opportunity_id INTEGER,
  channel        TEXT NOT NULL DEFAULT 'email',
  to_email       TEXT NOT NULL,
  to_name        TEXT,
  subject        TEXT NOT NULL,
  body           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft',
  run_id         TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at        TEXT,
  FOREIGN KEY(opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_outreach_chat ON outreach(chat_id, status);

CREATE TABLE IF NOT EXISTS pipeline_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id        INTEGER NOT NULL,
  opportunity_id INTEGER,
  type           TEXT NOT NULL,
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  chat_id     INTEGER,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',
  summary     TEXT,
  error       TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at    TEXT
);
`;

function openDb(): Database {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const connection = new Database(config.dbPath, { create: true });
  connection.exec("PRAGMA journal_mode = WAL;");
  connection.exec("PRAGMA synchronous = NORMAL;");
  connection.exec("PRAGMA foreign_keys = ON;");
  connection.exec("PRAGMA busy_timeout = 5000;");
  connection.exec(SCHEMA);
  return connection;
}

let rawDb = openDb();

function isIoError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = String((error as { code?: string }).code ?? "");
  return /disk I\/O|SQLITE_IOERR|vnode|malformed|database is locked/i.test(`${error.message} ${code}`);
}

export function reopenDb() {
  try {
    rawDb.close();
  } catch {}
  if (!existsSync(config.dbPath)) {
    for (const suffix of ["-wal", "-shm"]) {
      try {
        unlinkSync(`${config.dbPath}${suffix}`);
      } catch {}
    }
  }
  rawDb = openDb();
  log.warn("db.reopened", { path: config.dbPath });
}

type Statement = ReturnType<Database["query"]>;

function retry<T>(first: () => T, second: () => T): T {
  try {
    return first();
  } catch (error) {
    if (!isIoError(error)) throw error;
    log.warn("db.io_error", { error: error instanceof Error ? error.message : String(error) });
    reopenDb();
    return second();
  }
}

function wrapStatement(stmt: Statement, prepare: () => Statement): Statement {
  const wrapped = {
    run: (...args: unknown[]) => retry(() => stmt.run(...(args as never[])), () => prepare().run(...(args as never[]))),
    get: (...args: unknown[]) => retry(() => stmt.get(...(args as never[])), () => prepare().get(...(args as never[]))),
    all: (...args: unknown[]) => retry(() => stmt.all(...(args as never[])), () => prepare().all(...(args as never[]))),
    values: (...args: unknown[]) => retry(() => stmt.values(...(args as never[])), () => prepare().values(...(args as never[]))),
    finalize: () => stmt.finalize(),
    toString: () => stmt.toString(),
  };
  return wrapped as unknown as Statement;
}

export const db = new Proxy({} as Database, {
  get(_target, prop) {
    if (prop === "query") {
      return (sql: string) => {
        const prepare = () => rawDb.query(sql);
        return wrapStatement(retry(prepare, prepare), prepare);
      };
    }
    if (prop === "exec") {
      return (sql: string) => retry(() => rawDb.exec(sql), () => rawDb.exec(sql));
    }
    const value = (rawDb as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof value === "function" ? value.bind(rawDb) : value;
  },
});

export function ensureUser(chatId: number, username?: string) {
  db.query(
    `INSERT INTO users (chat_id, username) VALUES (?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET username = COALESCE(excluded.username, users.username), updated_at = datetime('now')`
  ).run(chatId, username ?? null);
}

export function getProfile(chatId: number): Record<string, unknown> {
  const row = db.query("SELECT profile FROM users WHERE chat_id = ?").get(chatId) as
    | { profile: string }
    | null;
  if (!row) return {};
  try {
    return JSON.parse(row.profile) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function setProfile(chatId: number, profile: Record<string, unknown>) {
  ensureUser(chatId);
  db.query("UPDATE users SET profile = ?, updated_at = datetime('now') WHERE chat_id = ?").run(
    JSON.stringify(profile),
    chatId
  );
}

export type Fact = {
  id: number;
  kind: string;
  key: string;
  value: string;
  source: string | null;
  created_at: string;
};

export function addFact(chatId: number, kind: string, key: string, value: string, source?: string) {
  ensureUser(chatId);
  db.query("INSERT INTO facts (chat_id, kind, key, value, source) VALUES (?, ?, ?, ?, ?)").run(
    chatId,
    kind,
    key,
    value,
    source ?? "agent"
  );
}

export function listFacts(chatId: number, kind?: string): Fact[] {
  if (kind) {
    return db
      .query("SELECT id, kind, key, value, source, created_at FROM facts WHERE chat_id = ? AND kind = ? ORDER BY id DESC")
      .all(chatId, kind) as Fact[];
  }
  return db
    .query("SELECT id, kind, key, value, source, created_at FROM facts WHERE chat_id = ? ORDER BY id DESC")
    .all(chatId) as Fact[];
}

export function deleteFacts(chatId: number, topic: string): number {
  const like = `%${topic}%`;
  const res = db
    .query("DELETE FROM facts WHERE chat_id = ? AND (key LIKE ? OR value LIKE ?)")
    .run(chatId, like, like);
  db.query("DELETE FROM chunks WHERE chat_id = ? AND text LIKE ?").run(chatId, like);
  return res.changes as number;
}

export function insertDocument(chatId: number, filename: string, mime: string | null, text: string): number {
  ensureUser(chatId);
  const res = db
    .query("INSERT INTO documents (chat_id, filename, mime, text, chars) VALUES (?, ?, ?, ?, ?)")
    .run(chatId, filename, mime, text, text.length);
  return Number(res.lastInsertRowid);
}

export type ChunkRow = {
  id: number;
  chat_id: number;
  source: string;
  text: string;
  embedding: string;
};

export function insertChunk(
  chatId: number,
  source: string,
  text: string,
  embedding: number[],
  documentId?: number
) {
  ensureUser(chatId);
  db.query(
    "INSERT INTO chunks (document_id, chat_id, source, text, embedding) VALUES (?, ?, ?, ?, ?)"
  ).run(documentId ?? null, chatId, source, text, JSON.stringify(embedding));
}

export function listChunks(chatId: number): ChunkRow[] {
  return db
    .query("SELECT id, chat_id, source, text, embedding FROM chunks WHERE chat_id = ?")
    .all(chatId) as ChunkRow[];
}

export type OpportunityStatus = "new" | "shortlisted" | "drafted" | "contacted" | "replied" | "interview" | "rejected" | "skipped" | "archived";

export type Opportunity = {
  id: number;
  chat_id: number;
  company: string;
  role: string;
  url: string;
  source: string;
  stage: string | null;
  funding_event: string | null;
  funding_date: string | null;
  launch_date: string | null;
  hiring: number;
  why: string | null;
  raw: string | null;
  discovered_at: string;
  signal_date: string | null;
  score: number | null;
  rationale: string | null;
  status: OpportunityStatus;
  created_at: string;
};

export type NewOpportunity = {
  company: string;
  role?: string;
  url: string;
  source: string;
  stage?: string;
  fundingEvent?: string;
  fundingDate?: string;
  launchDate?: string;
  hiring?: boolean;
  why?: string;
  raw?: unknown;
  signalDate?: string;
};

export function upsertOpportunity(chatId: number, opp: NewOpportunity): { id: number; inserted: boolean } | null {
  ensureUser(chatId);
  const existing = db
    .query("SELECT id FROM opportunities WHERE chat_id = ? AND company = ? AND role = ?")
    .get(chatId, opp.company, opp.role ?? "unknown") as { id: number } | null;
  if (existing) return { id: existing.id, inserted: false };

  const res = db
    .query(
      `INSERT INTO opportunities
        (chat_id, company, role, url, source, stage, funding_event, funding_date, launch_date, hiring, why, raw, signal_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      chatId,
      opp.company,
      opp.role ?? "unknown",
      opp.url,
      opp.source,
      opp.stage ?? null,
      opp.fundingEvent ?? null,
      opp.fundingDate ?? null,
      opp.launchDate ?? null,
      opp.hiring ? 1 : 0,
      opp.why ?? null,
      opp.raw === undefined ? null : JSON.stringify(opp.raw),
      opp.signalDate ?? null
    );
  return { id: Number(res.lastInsertRowid), inserted: true };
}

export function getOpportunity(chatId: number, id: number): Opportunity | null {
  return db
    .query("SELECT * FROM opportunities WHERE chat_id = ? AND id = ?")
    .get(chatId, id) as Opportunity | null;
}

export function listOpportunities(
  chatId: number,
  opts: { status?: string; limit?: number; minScore?: number } = {}
): Opportunity[] {
  const clauses = ["chat_id = ?"];
  const params: (string | number)[] = [chatId];
  if (opts.status) {
    clauses.push("status = ?");
    params.push(opts.status);
  }
  if (opts.minScore !== undefined) {
    clauses.push("COALESCE(score, 0) >= ?");
    params.push(opts.minScore);
  }
  params.push(opts.limit ?? 50);
  return db
    .query(
      `SELECT * FROM opportunities WHERE ${clauses.join(" AND ")}
       ORDER BY COALESCE(score, 0) DESC, discovered_at DESC LIMIT ?`
    )
    .all(...params) as Opportunity[];
}

export function updateOpportunityScore(chatId: number, id: number, score: number, rationale: string) {
  db.query("UPDATE opportunities SET score = ?, rationale = ? WHERE chat_id = ? AND id = ?").run(
    score,
    rationale,
    chatId,
    id
  );
}

export function setOpportunityStatus(chatId: number, id: number, status: OpportunityStatus) {
  db.query("UPDATE opportunities SET status = ? WHERE chat_id = ? AND id = ?").run(status, chatId, id);
}

export function addFeedback(chatId: number, opportunityId: number, signal: "up" | "down") {
  db.query("INSERT INTO feedback (chat_id, opportunity_id, signal) VALUES (?, ?, ?)").run(
    chatId,
    opportunityId,
    signal
  );
}

export function feedbackCounts(chatId: number): { up: number; down: number } {
  const rows = db
    .query("SELECT signal, COUNT(*) as n FROM feedback WHERE chat_id = ? GROUP BY signal")
    .all(chatId) as { signal: string; n: number }[];
  const out = { up: 0, down: 0 };
  for (const r of rows) {
    if (r.signal === "up") out.up = r.n;
    if (r.signal === "down") out.down = r.n;
  }
  return out;
}

export type Outreach = {
  id: number;
  chat_id: number;
  opportunity_id: number | null;
  channel: string;
  to_email: string;
  to_name: string | null;
  subject: string;
  body: string;
  status: string;
  run_id: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
};

export function createOutreach(input: {
  chatId: number;
  opportunityId?: number;
  channel?: string;
  toEmail: string;
  toName?: string;
  subject: string;
  body: string;
  runId?: string;
}): number {
  ensureUser(input.chatId);
  const res = db
    .query(
      `INSERT INTO outreach (chat_id, opportunity_id, channel, to_email, to_name, subject, body, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.chatId,
      input.opportunityId ?? null,
      input.channel ?? "email",
      input.toEmail,
      input.toName ?? null,
      input.subject,
      input.body,
      input.runId ?? null
    );
  return Number(res.lastInsertRowid);
}

export function getOutreach(chatId: number, id: number): Outreach | null {
  return db.query("SELECT * FROM outreach WHERE chat_id = ? AND id = ?").get(chatId, id) as Outreach | null;
}

export function listOutreach(chatId: number, status?: string): Outreach[] {
  if (status) {
    return db
      .query("SELECT * FROM outreach WHERE chat_id = ? AND status = ? ORDER BY id DESC")
      .all(chatId, status) as Outreach[];
  }
  return db.query("SELECT * FROM outreach WHERE chat_id = ? ORDER BY id DESC LIMIT 100").all(chatId) as Outreach[];
}

export function listOutreachByRun(chatId: number, runId: string): Outreach[] {
  return db
    .query("SELECT * FROM outreach WHERE chat_id = ? AND run_id = ? ORDER BY id")
    .all(chatId, runId) as Outreach[];
}

export function markOutreachSent(chatId: number, id: number) {
  db.query(
    "UPDATE outreach SET status = 'sent', sent_at = datetime('now') WHERE chat_id = ? AND id = ?"
  ).run(chatId, id);
}

export function markOutreachFailed(chatId: number, id: number, error: string) {
  db.query("UPDATE outreach SET status = 'failed', error = ? WHERE chat_id = ? AND id = ?").run(
    error,
    chatId,
    id
  );
}

export function updateOutreachContent(chatId: number, id: number, subject: string, body: string) {
  db.query("UPDATE outreach SET subject = ?, body = ? WHERE chat_id = ? AND id = ?").run(
    subject,
    body,
    chatId,
    id
  );
}

export function addPipelineEvent(chatId: number, opportunityId: number | null, type: string, note?: string) {
  db.query("INSERT INTO pipeline_events (chat_id, opportunity_id, type, note) VALUES (?, ?, ?, ?)").run(
    chatId,
    opportunityId,
    type,
    note ?? null
  );
}

export function listPipeline(chatId: number) {
  return db
    .query(
      `SELECT o.id, o.company, o.role, o.url, o.score, o.status, o.discovered_at,
              (SELECT COUNT(*) FROM outreach x WHERE x.opportunity_id = o.id) AS outreach_count
       FROM opportunities o
       WHERE o.chat_id = ? AND o.status NOT IN ('skipped', 'archived')
       ORDER BY CASE o.status
         WHEN 'interview' THEN 0 WHEN 'replied' THEN 1 WHEN 'contacted' THEN 2
         WHEN 'drafted' THEN 3 WHEN 'shortlisted' THEN 4 ELSE 5 END,
         COALESCE(o.score, 0) DESC
       LIMIT 40`
    )
    .all(chatId) as {
    id: number;
    company: string;
    role: string;
    url: string;
    score: number | null;
    status: string;
    discovered_at: string;
    outreach_count: number;
  }[];
}

export function insertRun(runId: string, chatId: number | null, kind: string) {
  db.query("INSERT INTO runs (id, chat_id, kind) VALUES (?, ?, ?)").run(runId, chatId, kind);
}

export function finishRun(runId: string, status: string, summary?: string, error?: string) {
  db.query(
    "UPDATE runs SET status = ?, summary = ?, error = ?, finished_at = datetime('now') WHERE id = ?"
  ).run(status, summary ?? null, error ?? null, runId);
}

export function getRun(runId: string) {
  return db.query("SELECT * FROM runs WHERE id = ?").get(runId) as
    | { id: string; chat_id: number | null; kind: string; status: string; summary: string | null; error: string | null; started_at: string; finished_at: string | null }
    | null;
}

export function getSetting(key: string): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
  ).run(key, value);
}

export function enqueueOutbox(chatId: number, kind: string, payload: unknown) {
  db.query("INSERT INTO outbox (chat_id, kind, payload) VALUES (?, ?, ?)").run(
    chatId,
    kind,
    JSON.stringify(payload)
  );
}

export function listPendingOutbox(limit = 20) {
  return db
    .query("SELECT * FROM outbox WHERE status = 'pending' ORDER BY id LIMIT ?")
    .all(limit) as { id: number; chat_id: number; kind: string; payload: string; attempts: number }[];
}

export function markOutboxSent(id: number) {
  db.query("UPDATE outbox SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(id);
}

export function markOutboxFailed(id: number, error: string) {
  db.query("UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?").run(
    error,
    id
  );
}

export function backupDb(targetPath: string) {
  db.exec(`VACUUM INTO '${targetPath.replaceAll("'", "''")}'`);
}
