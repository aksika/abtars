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

After installing packages with native addons, pnpm v10+ requires explicit approval for build scripts:

```bash
pnpm approve-builds -g    # select better-sqlite3 when prompted
```

### git (required)

`abtars install` clones the source repo. Git must be on PATH.

```bash
git --version   # any recent version works
```

### Telegram bot token (required)

Create a bot via [@BotFather](https://t.me/BotFather) on Telegram. You'll need:
- The bot token (e.g. `123456:ABC-DEF...`)
- Your chat ID (send `/start` to [@userinfobot](https://t.me/userinfobot))

### Model provider (at least one)

| Provider | Type | Setup |
|----------|------|-------|
| **ollama** | Local, free | `curl -fsSL https://ollama.ai/install.sh \| sh` then `ollama pull` a model |
| **OpenRouter** | Cloud, paid | Sign up at [openrouter.ai](https://openrouter.ai), get an API key |
| **Kiro CLI** | Local agent host | Install `kiro-cli` separately |
| **Gemini CLI** | Local agent host | Install `gemini` separately |

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

| Provider | Transport | Setup |
|----------|-----------|-------|
| ollama | Direct API | `ollama serve` locally, free |
| OpenRouter | Direct API | API key in `~/.abtars/secret/OPENROUTER_API_KEY` |
| Kiro CLI | ACP | `kiro-cli` installed |
| Gemini CLI | ACP | `gemini` installed |

Configure in `~/.abtars/config/transport.json`.

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
