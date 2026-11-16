# job-agent-bot — Feature Build List

The OpenCode Go API is wired up. This file tracks the build-out from "chat wrapper" to a real autonomous job-hunting agent.

Legend: `[x]` done · `[~]` partial · `[ ]` not done

**Status: the full loop is implemented and running.** Remaining gaps are listed at the bottom and are mostly external constraints (Wellfound has no public API, ATS forms vary per provider).

---

## Phase 0 — Live progress & reliable messaging

- [x] **Status message pattern** — one "working" message edited in place as steps complete
- [x] **Step reporting** — tool calls emit start/done/fail into the status renderer
- [x] **Typing indicator** — kept alive during long runs
- [x] **Long-message chunking** — 4096-char split on paragraph/line/word boundaries
- [x] **Error surfaces** — short reason in chat, full stack + run id in logs
- [x] **Final summary message** — status is replaced by the result or digest
- [x] **Message delivery guarantees** — 429/5xx retry with backoff, failed sends queued to the outbox and flushed on startup
- [x] **Allowlist** — `ALLOWED_USER_IDS` enforced before any handler

---

## Phase 1 — Input ingestion

- [x] **Text** routed through the tool-calling agent loop
- [x] **Voice notes (STT)** — local whisper.cpp `base.en` by default (ffmpeg → 16kHz WAV → whisper-cli), with optional API fallback
- [x] **Documents** — `.pdf`, `.docx`, `.md`, `.txt`, `.csv`
- [x] **Images/screenshots** — passed to the vision-capable model
- [x] **Forwarded messages** — prefixed and treated as context
- [x] **Slash commands** — `/start`, `/clear`, `/profile`, `/jobs`, `/status`, `/pause`, `/resume`, `/sources`, `/discover`, `/draft`, `/send`, `/pipeline`, `/followups`, `/memory`, `/weekly`, `/settings`, `/forget`, `/backup`, `/logs`, `/health`; registered with `setMyCommands` for the `/` menu
- [x] **Inline confirmations** — `Send / Edit / Skip` on drafts, `Open / Draft / Save / 👍 / 👎 / Skip` on digest items
- [x] **Conversational revision** — press Edit, reply with the change, get a rewritten draft

---

## Phase 2 — Memory

### Relational (SQLite)
- [x] Schema: users/profile, facts, documents, opportunities, feedback, outreach, pipeline events, runs, settings, outbox
- [x] Agent tools: `remember_fact`, `update_profile`, `forget`, `mark_opportunity`, `record_feedback`
- [x] Dedupe opportunities by company + role + URL
- [x] Experiences/projects/preferences modeled as typed facts
- [x] Profile derived into search terms (roles, skills, locations, industries, exclusions)

### RAG
- [x] Dependency-free feature-hashed embeddings + cosine recall
- [x] Chunked indexing of documents, profile, facts, and conversation history
- [x] `recall_memory` tool used before scoring and drafting
- [x] Tone samples stored and used in outreach
- [x] `/profile`, `/memory`, `/memory search <q>`, `/forget <topic>`

---

## Phase 3 — Discovery engine (8:00 AM IST)

- [x] **Scheduler** — timezone-aware cron (`Asia/Kolkata`), pause/resume, custom time via `/settings cron HH:MM`
- [x] **Source adapters** behind one interface:
  - [x] Y Combinator (recent batches, public company API)
  - [x] Hacker News ("Who is hiring?" via Algolia)
  - [x] Product Hunt (launches, Atom)
  - [x] TechCrunch + Crunchbase News (funding RSS)
  - [x] Remotive + Remote OK (remote roles)
  - [x] GitHub (active repos with hiring signals)
  - [x] Career pages — auto-scanned for live roles + `scan_career_page` tool
  - [x] Web search (Bing News RSS for "raises" / "hiring" headlines)
  - [x] Custom RSS (`WEB_SEARCH_RSS`) for anything else
  - [ ] Wellfound direct adapter — no public API; use a custom feed or manual link
- [x] **Signal extraction** — company, role, stage, funding/launch date, hiring, source URL, why-it-matters
- [x] **Freshness filter** — `FRESHNESS_DAYS` (default 14)
- [x] **Dedupe + store**
- [x] **Per-run caps** — `MAX_PER_SOURCE`, source timeouts, source error isolation
- [x] **Daily digest** — ranked, with inline actions
- [x] **On-demand run** — `/discover` and the `discover_jobs` tool
- [x] **Progress reporting** — each source reports `found / failed`

---

## Phase 4 — Fit scoring & ranking

- [x] **Heuristic rubric** — role, skills, industry, location, exclusions, funding, launch, hiring, freshness, source, feedback
- [x] **LLM-as-judge** — top candidates re-scored 0–100 with a one-line rationale
- [x] **Explainability** — rationale stored per opportunity and shown in the digest
- [x] **Threshold** — `MIN_FIT` (default 70)
- [x] **Feedback loop** — 👍/👎 buttons adjust future scores
- [x] **Watchlist** — saved/shortlisted opportunities get a score boost

---

## Phase 5 — Action layer

- [x] **Draft outreach email** in your tone, referencing the company's signal
- [x] **Draft LinkedIn DM** (shorter variant)
- [x] **Contact finding** — scrape company pages for emails, plus common patterns
- [x] **Send via Resend** behind `DRY_RUN` (default on) and explicit confirmation
- [x] **Auto-send gate** — agent refuses to send unless `/settings autosend on`
- [x] **Follow-ups** — `FOLLOW_UP_DAYS` cadence, list or draft
- [x] **Pipeline tracking** — new → shortlisted → drafted → contacted → replied → interview (or skipped/rejected)
- [x] **Action log** — every draft, send, and stage change stored
- [~] **Application assistance** — ready-to-send drafts and career-page role extraction; automatic ATS form submission is not implemented

---

## Phase 6 — Reliability & operations

- [x] **Serial work queue** — one agent/discovery task at a time per chat
- [x] **Self-healing SQLite** — reopens and recreates the schema on `SQLITE_IOERR`/missing-file errors
- [x] **Structured logs** — JSON logs with run ids under `data/agent.log`
- [x] **Health check** — `/health`
- [x] **Backups** — startup + every 12h, last 7 kept in `data/backups`
- [x] **Config** — env defaults plus DB-backed runtime overrides
- [x] **Graceful shutdown** — stop scheduler, stop bot, close DB
- [x] **Run history** — `/logs [runId]`
- [~] **Restart safety** — runs and the outbox persist; an in-flight agent task is not resumed
- [~] **Cost control** — step/source caps and request timeouts; no per-day token budget

---

## Phase 7 — Polish

- [x] Markdown-safe Telegram HTML rendering + chunking
- [x] Compact digest cards with inline actions
- [x] `/settings` menu (dry run, auto-send, min fit, digest size, cron)
- [x] Weekly summary (`/weekly`)
- [x] Multi-chat-ready schema (still gated by the allowlist)
- [x] README, `.env.example`, unit tests, typecheck

---

## Remaining / known gaps

- **Wellfound** has no public API and blocks scraping; the intended path is a custom RSS feed or manual forwarding.
- **Voice notes** require `whisper.cpp` + the `base.en` model locally (or set `STT_PROVIDER=auto`/`api` with an API key).
- **ATS autofill** differs per provider (Greenhouse/Lever/Ashby); the bot produces a ready-to-send package instead.
- **In-flight resume** would need a durable job queue (currently the queue is in memory).
- **Token budget** is not enforced per day, only per request/run.
- **Embeddings** are local and lexical-ish (feature hashing), not a neural embedding model. Swap `memory/rag.ts` for a hosted embedding endpoint if recall quality needs a boost.

---

## Build order used

```
Phase 0  →  Phase 1  →  Phase 2  →  Phase 3  →  Phase 4  →  Phase 5
(visibility) (inputs)   (memory)    (discovery) (ranking)   (actions)
                                    Phase 6 (harden)  →  Phase 7 (polish)
```
