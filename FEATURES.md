# job-agent-bot — Feature Build List

The OpenCode Go API is wired up and responding. Everything below is the build-out from "chat wrapper" to a real autonomous job-hunting agent.

Features are ordered by dependency: each phase is shippable on its own, and later phases assume the earlier ones exist.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Phase 0 — Live progress & reliable messaging (do this first)

Right now the bot goes silent while it thinks. Every long-running action must narrate itself in the chat so we always know what the agent is doing, and what it did.

- [ ] **Status message pattern** — on every request, send one "working" message and **edit it in place** as steps complete (instead of spamming new messages)
  - Format:
    ```
    🔍 Job agent working…
    ✅ Understood request
    ⏳ Searching Y Combinator…
    ⬜ Scoring fit
    ⬜ Drafting outreach
    ```
  - Throttle edits to ≤1 per second and only when the text actually changed (Telegram edit rate limits)
- [ ] **Step reporting from the agent loop** — each tool/step emits `step.start`, `step.done`, `step.fail` events that the status renderer consumes
- [ ] **Typing indicator** — `sendChatAction("typing")` kept alive (Telegram clears it after ~5s) during long runs
- [ ] **Long-message chunking** — split at 4096 chars on word boundaries, preserve code blocks (already partially done)
- [ ] **Error surfaces** — every failure replies with a short human-readable reason + run id, and logs the full stack
- [ ] **Final summary message** — replace the status message with a compact result (e.g. "found 6 companies, drafted 3 emails") plus expandable detail
- [ ] **Message delivery guarantees** — retry on `429` honoring `retry_after`, retry transient network errors, never drop a queued message silently
- [ ] **Allowlist** — ignore messages from any chat/user not in `ALLOWED_USER_IDS` (this bot will hold your personal data)

**Done when:** a 60-second agent run shows a live, self-updating status message and ends with a clear summary, and no crash ever leaves the chat silent.

---

## Phase 1 — Input ingestion (Telegram is the interface)

- [ ] **Text** — already working; route through the agent loop instead of a flat completion prompt
- [ ] **Voice notes (STT)** — download `.ogg`, transcribe, show "🎤 Transcribed: …" before acting, feed transcript to the agent
- [ ] **Documents** — accept `.pdf`, `.docx`, `.md`, `.txt`, `.csv`
  - Extract text, chunk, store in memory + attach as context for the current request
  - Echo back "📄 Ingested <filename> (n chars)" to confirm
- [ ] **Images/screenshots** — accept job-listing screenshots, OCR/vision into context
- [ ] **Forwarded messages** — treat a forwarded job post as a candidate opportunity
- [ ] **Slash commands**
  - `/start`, `/clear` (done)
  - `/profile` — show what the agent currently knows about me
  - `/jobs` — last discovery digest
  - `/status` — what's running now
  - `/pause` · `/resume` — stop/start scheduled discovery
  - `/sources` — toggle discovery sources
- [ ] **Inline confirmations** — for any action that sends email/applies, ask with inline buttons `✅ Send / ✏️ Edit / ❌ Skip`

**Done when:** you can talk to the bot by voice, drop a resume PDF, and it confirms what it ingested.

---

## Phase 2 — Memory (the actual differentiator)

Two local stores, per the architecture.

### Relational (structured)
- [ ] Schema: `profile`, `experience`, `skills`, `projects`, `preferences`, `companies_seen`, `opportunities`, `outreach`, `applications`, `runs`
- [ ] CRUD that the agent can call as tools (`remember_fact`, `update_profile`, `log_opportunity`)
- [ ] Dedupe opportunities by company + role + source URL

### RAG (semantic)
- [ ] Embed + index: resume, past write-ups, message history, ingested docs
- [ ] Retrieval tool the agent calls before scoring/outreach (`recall(query, k)`)
- [ ] Store **tone samples** (my own writing) so drafts sound like me
- [ ] Memory inspection: `/profile` renders the relational view; `/memory search <q>` runs retrieval

- [ ] **Write-through** — every conversation and every "I prefer X" statement is captured automatically, with a review step ("Got it — noted that you want remote-only. Correct?")
- [ ] **Forget** — `/forget <topic>` removes a memory and its embeddings

**Done when:** the agent can answer "what kind of role am I looking for and why?" using only its own memory.

---

## Phase 3 — Discovery engine (8:00 AM IST)

- [ ] **Scheduler** — cron at `0 8 * * *` in `Asia/Kolkata` (use a TZ-aware scheduler, not UTC math)
- [ ] **Source adapters** — one interface, `discover(profile) -> Opportunity[]`:
  - [ ] Y Combinator (batch + company directory)
  - [ ] Product Hunt (new launches)
  - [ ] TechCrunch / funding news (RSS + search)
  - [ ] Crunchbase (funding rounds)
  - [ ] Wellfound (startup roles)
  - [ ] GitHub (org activity / hiring signals)
  - [ ] Career pages (ATS endpoints: Greenhouse, Lever, Ashby where possible)
  - [ ] Web search fallback ("raised seed" + "hiring" + role keywords)
- [ ] **Signal extraction** — normalize each hit into: company, stage, funding event + date, launch date, open roles, source URL, why-it-matters
- [ ] **Freshness filter** — only keep signals within a configurable window (default 14 days)
- [ ] **Dedupe + store** — write to `opportunities`, skip ones already seen
- [ ] **Per-run budget** — cap sources/time/cost, report skipped sources
- [ ] **Daily digest message** — one Telegram message at 8:00 IST: top N companies, ranked, each with a one-line "why this fits"
- [ ] **On-demand run** — `/discover now` triggers the same pipeline outside the schedule
- [ ] **Progress reporting** — the 8 AM run narrates each source as it completes (Phase 0 renderer)

**Done when:** at 8:00 IST every day you get a ranked digest of fresh, funded, hiring startups — and nothing older than the freshness window.

---

## Phase 4 — Fit scoring & ranking

- [ ] **Scoring rubric** (configurable weights): role match, skills overlap, stage/size preference, location/remote, tech stack, comp band, funding recency
- [ ] **LLM-as-judge** — for the top ~25 candidates, ask the agent to score fit 0–100 with a 1-sentence rationale, grounded in retrieved memory
- [ ] **Explainability** — every score stores which memory facts drove it
- [ ] **Threshold** — only opportunities above `MIN_FIT` (default 70) reach the digest / action queue
- [ ] **Feedback loop** — `👍 / 👎` inline buttons on each digest item adjust future weights
- [ ] **Watchlist** — companies I explicitly care about get boosted and re-checked daily

**Done when:** the digest is short, specific, and mostly things I'd actually want to open.

---

## Phase 5 — The action layer (act for me)

Everything here requires an explicit confirmation (Phase 1 inline buttons) unless I've pre-authorized it.

- [ ] **Draft outreach email** — in my tone (retrieved from memory), referencing the company's funding/launch signal, with my resume attached
- [ ] **Draft LinkedIn / X DM** — shorter variant
- [ ] **Find the right contact** — founder/recruiter/hiring manager per company, with confidence + source
- [ ] **Send** — via an email provider (Resend/Postmark/SMTP) behind a `DRY_RUN` flag
- [ ] **Application assistance** — fill/queue ATS forms where possible; otherwise produce a ready-to-submit package
- [ ] **Follow-ups** — cadence (e.g. day 4, day 10), auto-drafted, never auto-sent without opt-in
- [ ] **Pipeline tracking** — `opportunities → outreach → reply → interview → outcome`, viewable with `/pipeline`
- [ ] **Action log** — every outbound message stored, so nothing is sent twice and everything is auditable

**Done when:** a morning digest item can become a sent, tone-matched email in two taps.

---

## Phase 6 — Reliability & operations

- [ ] **Job queue** — long runs (discovery, applications) run in a queue, not inline in the message handler
- [ ] **Restart safety** — persist queue + run state so a crash resumes instead of losing work
- [ ] **Structured logging** — JSON logs with `run_id`, `chat_id`, step timings; `/logs <run_id>` to fetch a run's trail
- [ ] **Cost & rate control** — token/call budget per run; backoff on provider limits
- [ ] **Health check** — `/health` reports bot, scheduler, memory DBs, and provider status
- [ ] **Backups** — nightly snapshot of the relational DB + RAG index
- [ ] **Config via env** — `ALLOWED_USER_IDS`, `TZ`, `MIN_FIT`, `DRY_RUN`, `CRON_DISCOVERY`, model name, source toggles
- [ ] **Graceful shutdown** — drain in-flight runs, close DBs, stop scheduler on `SIGINT`/`SIGTERM`

**Done when:** you can kill the process mid-discovery and it resumes cleanly on restart.

---

## Phase 7 — Polish

- [ ] Markdown-safe Telegram rendering (escape, code blocks, links)
- [ ] Compact digest cards with inline buttons: `Open · Draft · Save · Skip`
- [ ] `/settings` menu for sources, cron time, thresholds
- [ ] Weekly summary: opportunities seen, outreach sent, replies, interviews
- [ ] Multi-user-ready schema (still allowlisted, but not hard-coded to one chat)
- [ ] Usage docs in `README.md` as commands land

---

## Suggested build order

```
Phase 0  →  Phase 1  →  Phase 2  →  Phase 3  →  Phase 4  →  Phase 5
(visibility) (inputs)   (memory)    (discovery) (ranking)   (actions)
                                    Phase 6 (harden)  →  Phase 7 (polish)
```

Ship Phase 0 first: it makes every later phase debuggable, because you can watch the agent work instead of guessing.

---

## Proposed structure as this grows

```
job-agent-bot/
├── index.ts                 # bot bootstrap + handlers
├── agent/
│   ├── loop.ts              # request → tools → response
│   ├── tools.ts             # memory, discover, score, draft, send
│   └── events.ts            # step events → progress renderer
├── progress/
│   └── status.ts            # editable status message, throttling, chunking
├── memory/
│   ├── db.ts                # relational store
│   └── rag.ts               # embeddings + retrieval
├── discovery/
│   ├── scheduler.ts         # 8:00 AM IST cron
│   └── sources/*.ts         # yc, producthunt, crunchbase, wellfound, …
├── actions/
│   ├── email.ts             # drafting + sending (DRY_RUN aware)
│   └── pipeline.ts          # outreach / application tracking
└── config.ts                # env parsing + defaults
```
