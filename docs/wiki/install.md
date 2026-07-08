# Installation

See [Prerequisites](./prerequisites.md) before starting.

## Quick install (4 steps)

```bash
# 1. Install CLI tools
npm install -g abtars@alpha abmind@alpha

# 2. Optional deps (recommended before first start)
abtars deps install all

# 3. Install + deploy + start bridge
abtars install --non-interactive --accept-risk \
  --instance-name "MyBot" \
  --telegram-token "YOUR_BOT_TOKEN" \
  --telegram-chat-id "YOUR_CHAT_ID" \
  --user-name "yourname" \
  --passphrase "your-encryption-passphrase" \
  --default-provider openrouter \
  --default-model "deepseek/deepseek-v4-flash" \
  --api-key "sk-or-v1-..."

# 4. Install memory system (picks up username + agent name from abtars config)
abmind install --non-interactive \
  --passphrase "your-passphrase"
```

Step 3 automatically clones source, builds, deploys, and starts the bridge (daemon mode). The bot is live after this completes. Step 4 discovers username and agent name from the abtars config created in step 3 — no need to pass them again.

### What each step does

| Step | What happens |
|------|-------------|
| `npm install -g abtars@alpha abmind@alpha` | Installs CLI tools globally |
| `abtars deps install all` | Installs optional npm packages (browser, PDF, YouTube, image) |
| `abtars install` | Creates config, clones source, builds, deploys release, starts bridge |
| `abmind install` | Creates `~/.abmind/`, initializes memory DB, sets encryption (discovers user from abtars) |

### System dependencies (optional)

`abtars deps` manages two distinct kinds of optional dependency:

- **Npm packages** (`browser`, `pdf`, `youtube`, `image`, `native`) — auto-installed:
  `abtars deps install <name>` (or `all`) downloads and installs them for you.
- **System binaries** (`ollama`, `bwrap`, `lightpanda`) — installed manually. abtars
  does **not** run system installers or `sudo` for you. `abtars deps install ollama`
  prints the exact upstream command to run yourself; it does not install the binary.

```bash
abtars deps list          # shows both kinds + install hints
abtars deps install all   # installs the npm packages
abtars deps install ollama # prints ollama's manual install command (does not run it)
```

| System binary | What for | Install manually |
|-----------|----------|---------|
| ollama | Local embeddings + local models | `curl -fsSL https://ollama.ai/install.sh \| sh` |
| bwrap | Sandbox (Linux) | `apt install bubblewrap` |
| lightpanda | Fast web fetch | See https://lightpanda.io |

Install ollama before `abmind install` if you want local embeddings.

## Interactive install

Omit `--non-interactive` and the wizard will prompt for each value:

```bash
npm install -g abtars@alpha abmind@alpha
abtars deps install all
abtars install
abmind install
```

## Install modes

| Mode | How it works | Who |
|------|-------------|-----|
| **daemon** (default) | launchd/systemd manages watchdog → auto-restart on crash | Production |
| **simple** | No daemon, user runs `abtars start/stop` manually | Testing, development |

Set during install. Daemon mode starts automatically after `abtars install`. Simple mode requires `abtars start`.

**Simple mode note:** If you use optional deps (`abtars deps install`), add to your shell profile:
```bash
export NODE_PATH="$HOME/.local/lib/node_modules:$NODE_PATH"
```
Daemon mode sets this automatically.

## Install channels

| Channel | Command | Who |
|---|---|---|
| **Stable** | `npm install -g abtars abmind` | Production use |
| **Alpha** | `npm install -g abtars@alpha abmind@alpha` | Latest features, tested on live instances |
| **Dev** | `git clone` + `abtars update --dev .` | Contributors |

## Commands reference

```bash
abtars start          # Start bridge (simple mode) or load daemon
abtars stop           # Stop bridge + watchdog
abtars restart        # Warm restart (in-process)
abtars restart --cold # Kill + fresh start
abtars update         # Pull latest source, rebuild, deploy
abtars doctor         # Health check
abtars status         # Bridge status
abtars deps list      # Show optional deps
abtars deps install X # Install optional dep
```

## Updating

```bash
abtars update    # pulls latest source, rebuilds, deploys, restarts (daemon mode)
```

In simple mode, `update` deploys but doesn't restart. Run `abtars start` after.

## What gets created

```
~/.local/bin/
├── abtars               # CLI wrapper (overwritten on every deploy)
├── abtars-browser       # browser subprocess wrapper
├── abtars-task          # task subprocess wrapper
└── ...                  # other tool wrappers

~/.abtars/
├── config/              # .env, transport.json, users.json, peers.json
├── secret/              # API keys (encrypted at rest after first boot)
├── skills/              # core/ + custom/
├── logs/                # bridge-YYYY-MM-DD.log, watchdog.log
└── app -> releases/current  # symlink to active release

~/.abtars-releases/
├── src/                 # source checkouts (abtars/, abmind/)
├── <version>/           # deployed releases (e.g., 0.3.4-alpha.6)
├── current -> <version> # active release symlink
└── history.json         # release history

~/.local/lib/node_modules/   # unified native deps dir (better-sqlite3, optional deps)

~/.abmind/
└── memory/
    ├── memory.db        # SQLite + FTS5 + embeddings
    ├── core/            # SOUL.md, agent_notes.md, user_profile.md
    └── sleep/           # sleep cycle state + logs
```

## Providers

| Provider | What you need |
|----------|---------------|
| ollama | Running locally (`ollama serve`). Free, no API key. |
| OpenRouter | An API key from [openrouter.ai](https://openrouter.ai) |
| OpenAI | An API key from [platform.openai.com](https://platform.openai.com) |
| Anthropic | An API key from [console.anthropic.com](https://console.anthropic.com) |
| Kiro CLI | `kiro-cli` installed and on PATH |
| Gemini CLI | `gemini` installed and on PATH |

The install wizard asks for your provider and API key — it handles the rest.

Configure in `~/.abtars/config/transport.json`.

## Managing API keys

abTARS stores all secrets in `~/.abtars/secret/` — one file per key, encrypted at rest (AES-256-GCM). You never edit config files for keys.

### Adding a key after install

```bash
# Write the key (no trailing newline!)
echo -n "sk-or-v1-abc123..." > ~/.abtars/secret/OPENROUTER_API_KEY

# Restart to pick it up (encrypted automatically on boot)
abtars stop --force && abtars start
```

The filename becomes the environment variable name. That's the only rule.

### Provider keys

| Provider | Secret filename | Where to get it |
|----------|----------------|-----------------|
| OpenRouter | `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| OpenAI | `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Anthropic | `ANTHROPIC_API_KEY` | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |

### Service/skill keys (optional integrations)

| Service | Secret filename | Settings (in `.env.skills`) |
|---------|----------------|----------------------------|
| Home Assistant | `HA_TOKEN` | `HA_URL=http://192.168.1.4:8123` |
| Groq (voice STT) | `GROQ_API_KEY` | `STT_MODEL=whisper-large-v3` |
| Google AI (images) | `GOOGLE_AI_API_KEY` | `GOOGLE_AI_MODEL=gemini-2.0-flash-preview-image-generation` |
| Discord | `DISCORD_BOT_TOKEN` | `DISCORD_APP_ID=your-app-id` |

Example — adding Home Assistant:

```bash
# 1. Drop the long-lived access token
echo -n "eyJ0eXAi..." > ~/.abtars/secret/HA_TOKEN

# 2. Add non-secret settings
echo "HA_URL=http://192.168.1.4:8123" >> ~/.abtars/config/.env.skills

# 3. Restart
abtars stop --force && abtars start
```

Your agent can now control Home Assistant. See [Adding a Service](./add-service.md) for the full guide.

### Removing a key

```bash
rm ~/.abtars/secret/OPENAI_API_KEY
abtars stop --force && abtars start
```

### How it stays safe

- Files are AES-256-GCM encrypted at rest after the first boot
- Keys only exist as plaintext in memory while the bridge runs
- All secret files are `chmod 600` (owner-read only)
- `abtars doctor` checks vault integrity on every run
- Logs never contain secret values

See [Secrets Vault](./secrets.md) for the full technical details.

## Post-install verification

```bash
abtars doctor    # all green = healthy
abtars status    # shows PID, uptime, model
```

Send a message to your bot on Telegram — it should respond.

## Next steps

- [Health Check](./healthcheck.md) — verify everything is running correctly
- [Upgrading](./upgrade.md) — keep your bridge up to date
- [Backup & Restore](./backup.md) — protect your data
