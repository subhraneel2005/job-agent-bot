<p align="center">
  <img src="logo.png" alt="job-agent-bot logo" width="180" />
</p>

<h1 align="center">job-agent-bot</h1>

<p align="center">
  A Telegram-controlled, autonomous job-hunting agent that knows me, finds the right startups, and acts on my behalf.
</p>

<p align="center">
  <img alt="Bun" src="https://img.shields.io/badge/runtime-Bun-black?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178C6?style=flat-square" />
  <img alt="Telegram" src="https://img.shields.io/badge/interface-Telegram-26A5E4?style=flat-square" />
  <img alt="OpenCode Go" src="https://img.shields.io/badge/brain-OpenCode%20Go-6E56CF?style=flat-square" />
</p>

---

## The idea

Most "job bots" are scrapers with a chat window bolted on. This one is different.

> **A Telegram-controlled AI agent that continuously discovers new startup job opportunities, understands what fits me using its personal memory, and helps me apply or reach out to those companies.**

The architecture is built around a loop that isn't just search:

```
know me  →  find relevant companies  →  take job-search actions for me
```

It runs in the background, wakes up every morning, and surfaces the startups that just raised, just launched, or just started hiring — filtered through a memory of who I am.

---

## How it works

<p align="center">
  <img src="architecture.png" alt="System architecture" width="100%" />
</p>

| Layer | What it does |
| --- | --- |
| **Telegram** | The entire interface. Text, voice notes (local whisper.cpp base.en), PDFs/DOCX/CSV, screenshots, forwarded posts. |
| **OpenCode Go** | The AI brain. Tool-calling agent loop using `deepseek-v4.1-flash`. |
| **AI memory** | Local SQLite for structured facts + a local RAG index for semantic recall of documents and conversations. |
| **Scheduled discovery** | Cron-driven sweep at **8:00 AM IST**, with live progress in chat and a ranked digest. |

### 1. Telegram is the interface

Everything is driven from one chat. Send a sentence, a voice note, your resume as a PDF, a CSV of target companies, or a screenshot of a job listing. Voice notes are transcribed **locally** with whisper.cpp (`base.en`) — audio never leaves the machine. Every long-running action posts **one self-updating status message** (`⬜ → ⏳ → ✅`) so you always know what the agent is doing, then replaces it with the result.

### 2. OpenCode Go is the brain

The agent uses OpenAI-compatible chat completions with tool calling. Each request carries a per-chat `x-opencode-session` header, and the loop can call tools such as `discover_jobs`, `draft_outreach`, `remember_fact`, and `get_pipeline` before answering.

### 3. AI memory is the differentiator

Two local stores, backed by SQLite (`data/agent.db`):

- **Relational** — profile, facts, opportunities, feedback, outreach, pipeline events, runs, settings.
- **RAG** — dependency-free feature-hashed embeddings over your documents, resumes, notes, and conversation history, with cosine recall.

This is what turns a generic search into *my* search.

### 4. Discovery, every morning at 8:00 AM IST

| Source | Signal |
| --- | --- |
| **Y Combinator** | Recent batches (via the public company API) |
| **Hacker News** | The latest "Who is hiring?" thread (Algolia) |
| **TechCrunch**, **Crunchbase News** | Funding rounds and startup news (RSS) |
| **Product Hunt** | New launches (Atom) |
| **Remotive**, **Remote OK** | Fresh remote roles |
| **GitHub** | Active repos with hiring signals |
| **Career pages** | Auto-scans recent companies for live roles, plus a `scan_career_page` tool |
| **Web search** | Bing News headlines for "raises" / "hiring" signals |
| **HN RSS + custom RSS** | Extra hiring/funding feeds via `WEB_SEARCH_RSS` |

Each hit is normalized into company, role, stage, funding/launch date, hiring flag, source URL, and "why it matters". Results are deduped, filtered by freshness (`FRESHNESS_DAYS`, default 14), then scored.

> Wellfound is not scraped because it has no public API; add a feed with `WEB_SEARCH_RSS`. Funding news and career pages are read from public feeds and company pages. New adapters live in `discovery/sources/`.

### 5. Fit scoring: signal over noise

The agent combines a transparent heuristic score (skills, roles, industries, dealbreakers, funding recency, hiring, feedback) with an LLM re-rank that explains *why* each opportunity fits. Only opportunities above `MIN_FIT` (default 70) are preferred; if none qualify, the top 3 are shown so the digest is never empty. 👍/👎 buttons on each item tune later scoring.

### 6. The action layer

For a shortlisted company the agent can find likely contacts, draft an email or LinkedIn DM in your voice (using stored tone samples), let you revise it conversationally, and send it. Sending is **off by default** (`DRY_RUN=true`) and auto-send requires an explicit opt-in.

---

## Telegram formatting

Replies are converted from Markdown to Telegram HTML and sent with `parse_mode: "HTML"`, so `#`, `**`, and tables never appear raw.

| Input | Rendered |
| --- | --- |
| `## Title` | **Title** |
| `- item` | • item |
| `1. item` | 1. item |
| `> quote` | blockquote |
| `**bold**`, `_italic_`, `~~strike~~` | styled text |
| `` `code` ``, fenced blocks | code |
| `[label](url)` | link |
| tables | one row per line |

Messages cap at one emoji and are split into 4k chunks. The agent is instructed to answer first, skip filler, and keep normal replies under 100 words.

---

## What works today

- [x] Live, editable progress messages for every agent run
- [x] Tool-calling agent loop (memory, discovery, scoring, outreach, pipeline)
- [x] Text, local voice STT (whisper.cpp base.en), PDF/DOCX/MD/TXT/CSV ingestion, screenshots, forwarded posts
- [x] Local relational memory + RAG with recall
- [x] Profile/fact extraction and `/profile`
- [x] 8:00 AM IST scheduler with pause/resume and custom time
- [x] Discovery adapters: YC, HN, TechCrunch, Crunchbase News, Product Hunt, Remotive, Remote OK, GitHub, web search, custom RSS
- [x] Dedupe, freshness filtering, heuristic + LLM fit scoring, feedback loop
- [x] Daily digest with inline Open / Draft / Save / 👍 / 👎 / Skip buttons
- [x] Contact discovery, tone-matched drafts, revision by chat, Resend sending behind DRY_RUN
- [x] Follow-up cadence, pipeline tracking, weekly summary
- [x] Run log, health check, DB backups, graceful shutdown, message retry/chunking
- [x] Self-healing SQLite: reopens and recreates the schema if the DB file disappears
- [ ] Per-user isolation beyond chat IDs (schema is multi-chat ready)
- [ ] Direct ATS form submission (currently drafts a ready-to-send package)

See **[FEATURES.md](FEATURES.md)** for the original phased plan.

---

## Quickstart

### Prerequisites

- [Bun](https://bun.com) v1.3+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An OpenCode API key

### Install and configure

```bash
bun install
cp .env.example .env
```

Local voice transcription uses whisper.cpp `base.en`:

```bash
brew install whisper-cpp ffmpeg
bun run setup:whisper   # downloads models/ggml-base.en.bin
```

Set `STT_PROVIDER=whispercpp` (the default). If you prefer a hosted fallback, set `STT_PROVIDER=auto` or `api` with `OPENAI_API_KEY` or `STT_API_URL` + `STT_API_KEY`.

Minimum `.env`:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
OPENCODE_API_KEY=your_opencode_api_key
ALLOWED_USER_IDS=123456789   # strongly recommended — see /status for your ID
```

### Run

```bash
bun run check     # verify bot token, DB, scheduler, sources, whisper.cpp
bun run start     # run the bot
bun run dev       # hot reload
bun test          # unit tests
bun run typecheck # tsc --noEmit
```

Then open the bot in Telegram and send `/start`.

---

## Self-hosting

The bot uses long polling, so it needs **no inbound ports, no public URL, and no reverse proxy**.

For an always-on deployment:

1. Use a small VPS (1 vCPU, 1 GB RAM) or an always-on Mac.
2. Install Bun, `ffmpeg`, and `whisper.cpp`; clone the repo and run `bun install`.
3. `cp .env.example .env`, then set `TELEGRAM_BOT_TOKEN`, `OPENCODE_API_KEY`, and `ALLOWED_USER_IDS`.
4. Run `bun run setup:whisper` and `bun run check`.
5. Run it under systemd (Linux) or launchd (macOS).
6. Back up `data/` and keep `DRY_RUN=true` until sending is tested.

Full guide: **[SELF_HOSTING.md](SELF_HOSTING.md)** — server setup, systemd/launchd units, backups, updates, security, and troubleshooting.

---

## Commands

Typing `/` opens Telegram's inline command menu (registered with `setMyCommands` on startup).

| Command | What it does |
| --- | --- |
| `/discover` | Run a discovery sweep now |
| `/jobs` | List stored opportunities with scores |
| `/draft <id> [email]` | Draft outreach for an opportunity |
| `/send <id>` | Send a draft (respects DRY_RUN) |
| `/pipeline` | Pipeline grouped by stage |
| `/followups [draft]` | List or draft due follow-ups |
| `/profile` | What the agent knows about you |
| `/memory [search <q>]` | Memory stats or semantic search |
| `/weekly` | Last 7 days summary |
| `/status` | Scheduler, memory, recent runs |
| `/settings` | Model, cron, thresholds, email mode |
| `/settings dryrun on\|off` | Toggle sending |
| `/settings autosend on\|off` | Allow agent-initiated sends |
| `/settings minfit <n>` | Fit threshold |
| `/settings topn <n>` | Digest size |
| `/settings cron HH:MM` | Change daily discovery time |
| `/sources [all\|toggle <name>]` | Enable/disable sources |
| `/pause`, `/resume` | Pause scheduled discovery |
| `/forget <topic>` | Delete matching memories |
| `/backup` | Snapshot the database |
| `/logs [runId]` | Run history |
| `/health` | Component checks |
| `/clear` | Clear chat context (keeps memory) |

You can also just talk to it:

> "I'm a backend engineer, remote-only, seed-stage AI startups, and I hate take-home tests. Remember that."

> "Find me three companies that raised this week and draft the best one."

---

## Configuration

All settings are optional except the two secrets. Full template in [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALLOWED_USER_IDS` | empty | Comma-separated Telegram user IDs allowed to use the bot |
| `TZ` | `Asia/Kolkata` | Scheduler timezone |
| `CRON_DISCOVERY` | `0 8 * * *` | Daily discovery cron |
| `FRESHNESS_DAYS` | `14` | Max age of a signal |
| `MIN_FIT` | `70` | Digest threshold |
| `DIGEST_TOP_N` | `8` | Items per digest |
| `MAX_PER_SOURCE` | `25` | Cap per adapter |
| `CAREER_SCAN_LIMIT` | `3` | Companies whose career pages are scanned per run |
| `SOURCES` | all | Comma-separated source names |
| `WEB_SEARCH_RSS` | empty | Extra RSS feed URLs |
| `DRY_RUN` | `true` | Never actually send email |
| `RESEND_API_KEY` | empty | Enables live sending |
| `EMAIL_FROM`, `EMAIL_REPLY_TO` | — | Sender identity |
| `USER_NAME`, `USER_EMAIL`, `USER_GITHUB`, `USER_LINKEDIN`, `USER_WEBSITE` | — | Used in outreach |
| `FOLLOW_UP_DAYS` | `4,10` | Follow-up cadence |
| `DATA_DIR` | `./data` | SQLite DB, logs, backups |
| `MAX_AGENT_STEPS` | `8` | Tool-call loop cap |
| `OPENAI_API_KEY` / `STT_API_URL` + `STT_API_KEY` | — | Optional remote STT fallback (`STT_PROVIDER=api` or `auto`) |
| `WHISPER_CPP_BIN` | `whisper-cli` | Local whisper.cpp binary |
| `WHISPER_CPP_MODEL` | `./models/ggml-base.en.bin` | Local whisper.cpp model |
| `WHISPER_CPP_LANG` | `en` | Transcription language |
| `WHISPER_CPP_THREADS` | `4` | whisper.cpp threads |
| `STT_PROVIDER` | `whispercpp` | `whispercpp`, `api`, or `auto` |

Runtime settings changed with `/settings` are stored in the database and override env defaults.

---

## Project structure

```
job-agent-bot/
├── index.ts                  # bot bootstrap, handlers, callbacks, scheduler
├── config.ts                 # env parsing + defaults
├── logger.ts                 # structured logs
├── agent/
│   ├── loop.ts               # tool-calling agent loop + sessions
│   └── tools.ts              # memory, discovery, scoring, outreach tools
├── ai/client.ts              # OpenCode chat completions, JSON, STT
├── memory/
│   ├── db.ts                 # SQLite schema + self-healing queries
│   └── rag.ts                # chunking, embeddings, recall
├── discovery/
│   ├── pipeline.ts           # run adapters → dedupe → score
│   ├── score.ts              # heuristic + LLM scoring
│   ├── digest.ts             # digest text + inline keyboard
│   ├── scheduler.ts          # timezone-aware cron
│   ├── profile.ts            # profile → search terms
│   └── sources/              # yc, hn, remotive, remoteok, github, web, rss
├── actions/
│   ├── contacts.ts           # contact discovery
│   ├── careers.ts            # career-page role extraction
│   ├── email.ts              # draft, revise, send
│   └── pipeline.ts           # follow-ups, weekly summary
├── ingest/extract.ts         # PDF, DOCX, CSV, text extraction
├── stt/whispercpp.ts         # local whisper.cpp transcription
├── runtime/
│   ├── settings.ts           # DB-backed runtime overrides
│   └── queue.ts              # per-chat serial queue
├── telegram/
│   ├── progress.ts           # editable status messages
│   ├── format.ts             # chunking + safe HTML
│   ├── commands.ts           # slash command menu
│   └── retry.ts              # 429/5xx retry
├── tests/core.test.ts
├── data/                     # created at runtime (gitignored)
├── models/                   # whisper model (gitignored)
├── SELF_HOSTING.md           # deployment guide
├── logo.png
└── architecture.png
```

---

## Safety

- **Allowlist first.** Set `ALLOWED_USER_IDS`; the bot ignores everyone else.
- **Nothing is sent by default.** `DRY_RUN=true` turns sends into previews.
- **Auto-send is opt-in.** Even with dry-run off, the agent refuses to send unless `/settings autosend on` is set or you press the Send button.
- **Everything is auditable.** Every draft, send, pipeline change, and run is stored in SQLite and `/logs`.
- **Local data.** The DB, RAG index, logs, and backups live under `data/`.
- **Don't delete `data/` while the bot is running.** The connection self-heals if the file disappears, but rows written to the old file are gone.
- **Avoid cloud-synced data dirs.** SQLite under iCloud Drive / Desktop & Documents can throw `SQLITE_IOERR_VNODE`; set `DATA_DIR` to a local path if needed.

---

## Tech stack

- **[Bun](https://bun.com)** — runtime, HTTP, SQLite, tests
- **[grammY](https://grammy.dev)** — Telegram Bot API
- **[OpenCode Go](https://opencode.ai)** — inference (`deepseek-v4.1-flash`)
- **[unpdf](https://github.com/unjs/unpdf)** / **[mammoth](https://github.com/mwilliamson/mammoth.js)** — PDF and DOCX extraction
- **[whisper.cpp](https://github.com/ggml-org/whisper.cpp)** + `ffmpeg` — local voice transcription (`base.en`)
- **[fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser)** — RSS/Atom
- **TypeScript** — strict, end to end

---

## Philosophy

A job search is not a keyword query. It's a judgment call about fit — company stage, product, team, timing, and whether the work matches the person you actually are.

This agent is built to make that judgment *for me*, continuously, in the background, and to act on it without needing a dashboard, a spreadsheet, or another tab.
