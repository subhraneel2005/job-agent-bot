# Self-hosting job-agent-bot

Run the bot on your own machine or VPS and control it from Telegram. The bot uses **long polling**, so it needs **no public URL, no open inbound ports, and no reverse proxy**.

---

## What you need

| Requirement | Notes |
| --- | --- |
| Bun | v1.3+ |
| Telegram bot token | Create one with [@BotFather](https://t.me/BotFather) |
| OpenCode API key | Chat completions and tool calling |
| `ffmpeg` | Converts voice notes to 16 kHz WAV |
| whisper.cpp + `base.en` model | Local voice transcription (~141 MB) |
| Optional STT API key | Fallback if you do not want local whisper |

Minimum server: **1 vCPU, 1 GB RAM, 5 GB disk**. The bot is outbound-only. A small VPS is enough; a Raspberry Pi also works, but whisper will be slower.

---

## 1. Install the runtime

### macOS

```bash
brew install bun ffmpeg whisper-cpp
```

### Debian / Ubuntu

```bash
curl -fsSL https://bun.sh/install | bash
sudo apt update && sudo apt install -y ffmpeg cmake build-essential git curl

git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build
cmake --build build --config Release -j
sudo cp build/bin/whisper-cli /usr/local/bin/
```

### Fedora

```bash
curl -fsSL https://bun.sh/install | bash
sudo dnf install -y ffmpeg cmake gcc-c++ make git curl

git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build
cmake --build build --config Release -j
sudo cp build/bin/whisper-cli /usr/local/bin/
```

Make sure `bun`, `ffmpeg`, and `whisper-cli` are on `PATH`:

```bash
bun --version
ffmpeg -version
whisper-cli --help
```

On Windows, use WSL2 and follow the Debian steps.

---

## 2. Clone and install

```bash
git clone git@github.com:subhraneel2005/job-agent-bot.git
cd job-agent-bot
bun install
```

If you are deploying on a server, create a dedicated user:

```bash
sudo useradd --system --create-home --shell /bin/bash jobagent
sudo mkdir -p /opt/job-agent-bot
sudo chown jobagent:jobagent /opt/job-agent-bot
```

Clone into `/opt/job-agent-bot` as that user, or move the directory there.

---

## 3. Configure

```bash
cp .env.example .env
chmod 600 .env
```

Minimum:

```env
TELEGRAM_BOT_TOKEN=your_bot_token
OPENCODE_API_KEY=your_opencode_key
ALLOWED_USER_IDS=123456789
```

Strongly recommended:

```env
ALLOWED_USER_IDS=123456789      # comma-separated Telegram user IDs
TZ=Asia/Kolkata
CRON_DISCOVERY=0 8 * * *
DRY_RUN=true                    # keep on until you trust sending
DATA_DIR=./data
```

`ALLOWED_USER_IDS` is your Telegram user ID, not the bot ID. Send `/start` to the bot once, then `/status`; it prints `Telegram ID: ...`.

Never commit `.env`. It is already in `.gitignore`.

---

## 4. Download the whisper model

```bash
bun run setup:whisper
```

This downloads `models/ggml-base.en.bin` (~141 MB). To use a different location:

```env
WHISPER_CPP_MODEL=/absolute/path/to/ggml-base.en.bin
```

If you prefer a hosted STT provider instead:

```env
STT_PROVIDER=api
STT_API_URL=https://api.openai.com/v1/audio/transcriptions
STT_API_KEY=...
STT_MODEL=whisper-1
```

Or use `STT_PROVIDER=auto` to try local first and fall back to the API.

---

## 5. Verify

```bash
bun run check
```

It confirms the Telegram token, database, scheduler, discovery sources, and whisper.cpp/model. You should see `"whisper": "ready"`.

Then start the bot:

```bash
bun run start
```

Open the bot in Telegram and send `/start`. Type `/` to see the command menu.

---

## 6. Run it permanently

### Linux: systemd

Create `/etc/systemd/system/job-agent-bot.service`:

```ini
[Unit]
Description=job-agent-bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=jobagent
Group=jobagent
WorkingDirectory=/opt/job-agent-bot
EnvironmentFile=/opt/job-agent-bot/.env
Environment=DATA_DIR=/var/lib/job-agent-bot
Environment=WHISPER_CPP_MODEL=/opt/job-agent-bot/models/ggml-base.en.bin
ExecStart=/home/jobagent/.bun/bin/bun run start
Restart=always
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/job-agent-bot

[Install]
WantedBy=multi-user.target
```

Enable it:

```bash
sudo mkdir -p /var/lib/job-agent-bot
sudo chown jobagent:jobagent /var/lib/job-agent-bot
sudo systemctl daemon-reload
sudo systemctl enable --now job-agent-bot
sudo systemctl status job-agent-bot
```

Logs:

```bash
journalctl -u job-agent-bot -f
```

The bot also writes JSON logs to `/var/lib/job-agent-bot/agent.log`.

### macOS: launchd

Create `~/Library/LaunchAgents/com.jobagent.bot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.jobagent.bot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/.bun/bin/bun</string>
    <string>run</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOU/Desktop/Projects/job-agent-bot</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/Users/YOU/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/YOU/Library/Logs/job-agent-bot.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOU/Library/Logs/job-agent-bot.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load -w ~/Library/LaunchAgents/com.jobagent.bot.plist
launchctl list | grep jobagent
```

Bun loads `.env` from the working directory automatically.

---

## 7. Data, backups, and logs

```text
data/
├── agent.db          # SQLite: profile, facts, jobs, outreach, runs
├── agent.log         # JSON logs
└── backups/          # automatic snapshots, last 7 kept
```

- Backups are created at startup and every 12 hours.
- `/backup` creates one immediately.
- Copy `data/backups/` off the machine (rclone, restic, S3) if you care about the data.
- Backups contain personal data. Encrypt them.

Restore:

```bash
sudo systemctl stop job-agent-bot
rm -f /var/lib/job-agent-bot/agent.db-wal /var/lib/job-agent-bot/agent.db-shm
cp /var/lib/job-agent-bot/backups/agent-YYYY-MM-DD....db /var/lib/job-agent-bot/agent.db
sudo systemctl start job-agent-bot
```

---

## 8. Updating

```bash
cd /opt/job-agent-bot
git pull --ff-only
bun install
bun run check
sudo systemctl restart job-agent-bot
```

Back up `data/` before updating. The schema uses `CREATE TABLE IF NOT EXISTS`; there is no migration framework yet.

---

## 9. Security checklist

- Set `ALLOWED_USER_IDS`. An open bot can read your memory and send outreach.
- Keep `DRY_RUN=true` until sending is configured and tested.
- Never commit `.env`; rotate the Telegram token if it leaks.
- Run as a non-root user.
- `chmod 700 data`, `chmod 600 .env`.
- Encrypt the disk or the `data/` directory if it holds resumes and personal notes.
- Only outbound HTTPS is needed. Do not expose the bot to the internet.
- Back up and protect the database; it contains personal data.
- If you use a hosted STT or AI provider, review their retention policy.

---

## 10. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Bot does not respond | Another instance is polling (`409 Conflict`). Run `pkill -f "bun.*index.ts"` or stop the other service. Check the token. |
| `This bot is private` | Your Telegram user ID is not in `ALLOWED_USER_IDS`. Get it from `/status` or @userinfobot. |
| Voice notes fail | Check `bun run check` shows `whisper: ready`. Install `whisper-cli` + `ffmpeg`, or set `WHISPER_CPP_BIN` / `WHISPER_CPP_MODEL`. |
| `SQLITE_IOERR_VNODE` | `DATA_DIR` is on iCloud/Desktop & Documents, or the file was deleted while running. Set `DATA_DIR=$HOME/.job-agent-bot` and restart. |
| `database is locked` | Run only one bot instance per database. The connection has a busy timeout and self-heals on most I/O errors. |
| `MissingSessionID` from OpenCode | Ensure `OPENCODE_API_URL` and `OPENCODE_API_KEY` are correct and the code is up to date; requests send `x-opencode-session`. |
| AI errors / empty replies | Check the key, quota, and model name. Try `bun run check`. |
| `/` menu is empty | `setMyCommands` failed at startup. Restart the bot and reopen the chat. Commands still work if typed. |
| Email never sends | `DRY_RUN` is on by default. Set `/settings dryrun off`, configure `RESEND_API_KEY` and `EMAIL_FROM`, then confirm each send or enable `/settings autosend on`. |
| Discovery runs at the wrong time | Set `TZ` and `CRON_DISCOVERY`. The default is `0 8 * * *` in `Asia/Kolkata`. |
| File upload rejected | Telegram bots can download files up to 20 MB. |

---

## 11. Health checks

From Telegram:

- `/health` — database, AI key, model, scheduler, memory, email, STT
- `/status` — schedule, next run, memory, sources, recent runs
- `/logs` — recent runs
- `/backup` — immediate snapshot

From the shell:

```bash
systemctl status job-agent-bot
journalctl -u job-agent-bot -n 100
tail -f data/agent.log
```

---

## 12. What is not included

This repository is the Telegram bot only.

- No web app, Gmail OAuth, or calendar booking yet.
- No multi-tenant isolation beyond chat IDs; it is designed for one person or a small allowlist.
- No Dockerfile. Use systemd or launchd.
- No hosted billing or pricing.
