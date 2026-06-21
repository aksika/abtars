# Installation

## Prerequisites

### Node.js 22+ (required)

abTARS requires Node.js 22 or later. Recommended: Node.js 24 (latest even release).

**macOS (Homebrew):**

```bash
brew install node@24
brew link node@24
node --version   # should show v24.x.x
```

**Linux / WSL (NodeSource):**

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should show v24.x.x
```

### pnpm (required)

```bash
npm install -g pnpm
```

After installing abTARS, pnpm will ask you to approve native module compilation. Just follow the prompt:

```bash
pnpm approve-builds -g    # select better-sqlite3, press Enter
```

### git (required)

```bash
git --version   # any recent version
```

### Telegram bot token (required)

Create a bot via [@BotFather](https://t.me/BotFather) on Telegram. You'll need:
- The bot token (e.g. `123456:ABC-DEF...`)
- Your chat ID (send `/start` to [@userinfobot](https://t.me/userinfobot))

### Model provider (at least one)

| Provider | Type | Setup |
|----------|------|-------|
| **ollama** | Local, free | `curl -fsSL https://ollama.ai/install.sh \| sh` (Linux) or `brew install ollama` (macOS) |
| **OpenRouter** | Cloud, aggregator | Sign up at [openrouter.ai](https://openrouter.ai), get an API key. Access to all major models. |
| **OpenAI** | Cloud, direct | API key from [platform.openai.com](https://platform.openai.com) |
| **Anthropic** | Cloud, direct | API key from [console.anthropic.com](https://console.anthropic.com) |
| **Kiro CLI** | Local AI coding tool | Install [Kiro](https://kiro.dev) separately |
| **Gemini CLI** | Local AI coding tool | Install [Gemini CLI](https://github.com/google-gemini/gemini-cli) separately |

### Model requirements

abTARS works with any LLM that supports the OpenAI chat completions API format, including local models via ollama.

| | Minimum | Recommended |
|---|---|---|
| **Context window** | 32K tokens | 128K+ tokens |
| **Model quality** | Any instruction-following model | State-of-the-art (GPT-4o, Claude, Gemini Pro, DeepSeek V3+) |

**Context window:** abTARS works with 32K models, but tool use eats context fast. 128K+ recommended for comfortable operation.

**Model quality and security:** abTARS injects persona, memory, and tool schemas into the system prompt. Weaker models may leak instructions or follow injected prompts from user messages. For production, use frontier models.

### Optional dependencies

| Dependency | What for | macOS | Linux/WSL |
|-----------|----------|-------|-----------|
| ollama | Local embeddings + models | `brew install ollama` | See [ollama.ai](https://ollama.ai) |
| bubblewrap | Sandbox (Linux only) | N/A | `apt install bubblewrap` |
| lightpanda | Fast web fetch | See [lightpanda.io](https://lightpanda.io) | See [lightpanda.io](https://lightpanda.io) |

Or install all optional npm deps at once after the CLI is available:

```bash
abtars deps install all
```

## Quick install (4 steps)

```bash
# 1. Install CLI tools
pnpm install -g abtars@alpha abmind@alpha

# 2. Optional deps (recommended before first start)
abtars deps install all

# 3. Install memory system
abmind install --non-interactive \
  --agent-name "MyBot" \
  --username "yourname" \
  --passphrase "your-passphrase"

# 4. Install + deploy + start bridge
abtars install --non-interactive --accept-risk \
  --instance-name "MyBot" \
  --telegram-token "YOUR_BOT_TOKEN" \
  --telegram-chat-id "YOUR_CHAT_ID" \
  --user-name "yourname" \
  --default-provider openrouter \
  --default-model "deepseek/deepseek-v4-flash" \
  --api-key "sk-or-v1-..."
```

Step 4 automatically clones source, builds, deploys, and starts the bridge (daemon mode). The bot is live after this completes.

### What each step does

| Step | What happens |
|------|-------------|
| `pnpm install -g abtars@alpha abmind@alpha` | Installs CLI tools globally |
| `abtars deps install all` | Installs optional npm packages (browser, PDF, YouTube, image) |
| `abmind install` | Creates `~/.abmind/`, initializes memory DB, sets encryption |
| `abtars install` | Creates config, clones source, builds, deploys release, starts bridge |

### System dependencies (optional)

```bash
abtars deps list    # shows what's available + install hints
```

| Dependency | What for | Install |
|-----------|----------|---------|
| ollama | Local embeddings + local models | `curl -fsSL https://ollama.ai/install.sh \| sh` |
| bwrap | Sandbox (Linux) | `apt install bubblewrap` |
| lightpanda | Fast web fetch | See https://lightpanda.io |

Install ollama before `abmind install` if you want local embeddings.

## Interactive install

Omit `--non-interactive` and the wizard will prompt for each value:

```bash
pnpm install -g abtars@alpha abmind@alpha
abtars deps install all
abmind install
abtars install
```

## Install modes

| Mode | How it works | Who |
|------|-------------|-----|
| **daemon** (default) | launchd/systemd manages watchdog → auto-restart on crash | Production |
| **simple** | No daemon, user runs `abtars start/stop` manually | Testing, development |

Set during install. Daemon mode starts automatically after `abtars install`. Simple mode requires `abtars start`.

## Install channels

| Channel | Command | Who |
|---|---|---|
| **Stable** | `pnpm install -g abtars abmind` | Normal users |
| **Alpha** | `pnpm install -g abtars@alpha abmind@alpha` | Early adopters |
| **Dev** | `git clone` + `abtars update --local` | Contributors |

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
~/.abtars/
├── config/              # .env, transport.json, users.json, peers.json
├── secret/              # API keys (encrypted at rest after first boot)
├── skills/              # core/ + custom/
├── logs/                # bridge-YYYY-MM-DD.log, watchdog.log
├── bin/                 # CLI wrapper (abtars)
├── app -> releases/current  # symlink to active release
└── lib/                 # optional deps (abtars deps install)

~/.abtars-releases/
├── src/                 # source checkouts (abtars/, abmind/)
├── <commit>/            # deployed releases
├── current -> <commit>  # active release symlink
└── history.json         # release history

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

Your agent can now control Home Assistant. See [Adding a Service](./add-service.md) for the full guide (including writing skills).

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

## Backup & Restore

```bash
abtars backup                    # creates ~/.backup-abtars/abtars-<date>.zip
abtars restore ~/path/to.zip    # restores config + data
abmind restore --input ~/path/to.abm --passphrase "X" --username "Y"
```

## Troubleshooting

See [Health Check](./healthcheck.md) and [Troubleshooting](./troubleshooting.md).
