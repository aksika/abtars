# Installation

## Requirements

- Node.js 22+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather)) or Discord bot token
- At least one model provider (ollama, OpenRouter, Kiro CLI, Gemini CLI, Codex, or Claude Code)

### Model requirements

abTARS can run with any LLM that supports the OpenAI chat completions API format, including local models via ollama.

| | Minimum | Recommended |
|---|---|---|
| **Context window** | 32K tokens | 128K+ tokens |
| **Model quality** | Any instruction-following model | State-of-the-art (GPT-4o, Claude, Gemini Pro, DeepSeek V3+) |

**Context window:** abTARS works with 32K context models (including small local models), but the experience degrades quickly with tool use. The soul bundle, tool definitions, and session history consume ~20% of a 32K window at startup, leaving limited room for conversation. With 128K+ models, the agent can hold long conversations with heavy tool use without losing context.

**Model quality and security:** abTARS injects persona instructions, memory context, and tool schemas into the system prompt. Weaker models may leak internal instructions to users, follow injected instructions from user messages, or fail to respect classification boundaries. For deployments where prompt injection resistance matters, use state-of-the-art frontier models — they have significantly better instruction-following and are harder to manipulate.

## Agent install

Give this page to your favourite AI agent (Claude, Gemini, Codex, Kiro) and ask it to install abTARS for you. It has all the information it needs right here. 😉

## Install channels

| Channel | Command | Who |
|---|---|---|
| **Stable** | `npm install -g abtars abmind` | Normal users |
| **Alpha** | `npm install -g abtars@alpha abmind@alpha` | Early adopters, testers |
| **Dev** | `git clone` + `abtars update --from-local` | Contributors, developers |

Stable ≤ Alpha ≤ Dev.

## Manual install (npm)

### Stable (recommended)

```bash
npm install -g abtars abmind
abmind install
abtars install
abtars update
abtars onboard
sudo $(which abtars) daemon install
```

### Alpha (latest features, may have bugs)

```bash
npm install -g abtars@alpha abmind@alpha
abmind install
abtars install
abtars update
abtars onboard
sudo $(which abtars) daemon install
```

### Git (development, build from source)

```bash
git clone git@github.com:aksika/abtars.git
git clone git@github.com:aksika/abmind.git
cd abmind && npm install && npm run build && cd ..
cd abtars && npm install && abtars update --from-local
abtars onboard
sudo $(which abtars) daemon install
```

| Step | What happens |
|------|-------------|
| `npm install -g abtars abmind` | Installs CLI tools globally (stable channel) |
| `abmind install` | Creates `~/.abmind/`, prompts for encryption passphrase, initializes memory DB |
| `abtars install` | Creates `~/.abtars/` skeleton (config, scripts, skills) |
| `abtars update` | Stages the release (copies bundle to `~/.abtars/releases/`) |
| `abtars onboard` | Interactive setup: Telegram token, model, user ID |
| `sudo ... daemon install` | Registers systemd service, starts the bridge |

After `daemon install`, the bridge is running and responding to messages. No separate restart needed.

## Install from source (git clone)

```bash
git clone https://github.com/aksika/abtars.git
cd abtars
npm install
npm run bundle
abtars install
abtars update --from-local
abtars onboard
sudo $(which abtars) daemon install
```

To update after pulling new commits:

```bash
git pull
abtars update --from-local
```

This rebuilds and hot-restarts the bridge in one command.

## Memory (abmind)

`abmind` is optional but recommended. Without it, the bridge responds but forgets between sessions. The `abtars onboard` wizard installs it automatically if available on PATH.

What memory adds:
- Persistent recall across sessions
- Overnight sleep maintenance (fact extraction, consolidation)
- Emotion tagging and memory promotion
- Searchable memory via tools
- Personalized SOUL (agent identity)

## Daemon management

```bash
abtars daemon status      # show service state
sudo systemctl stop abtars       # stop
sudo systemctl start abtars      # start
sudo systemctl restart abtars    # restart
sudo $(which abtars) daemon uninstall   # remove the service
```

For development (no daemon):
```bash
abtars start    # direct start, foreground watchdog
abtars stop     # stop
```

## What gets created

```
~/.abtars/
├── config/          # .env, transport.json, models.json, users.json
├── secret/          # API keys (encrypted at rest)
├── current/         # symlink → active release
├── releases/        # versioned bundles
├── logs/            # bridge-YYYY-MM-DD.log
├── scripts/         # watchdog.sh, doctor.sh
├── skills/          # core/ + custom/ + self/
├── workspace/       # agent working directory
└── bridge.pid       # PID of running bridge

~/.abmind/           # (only after abmind install)
└── memory/
    ├── memory.db    # SQLite + FTS5 + embeddings
    ├── core/        # SOUL.md, agent_notes.md, user_profile.md
    ├── daily/       # daily summaries + retrospectives
    └── sleep/       # sleep cycle state + logs
```

## Providers

| Provider | Transport | Setup |
|----------|-----------|-------|
| ollama | Direct API | `ollama serve` locally, free |
| OpenRouter | Direct API | API key in `~/.abtars/secret/OPENROUTER_API_KEY` |
| Kiro CLI | ACP | `kiro-cli` installed, AWS account |
| Gemini CLI | ACP | `gemini` installed, Google account |
| Codex | Direct API | `codex` installed, OpenAI account |
| Claude Code | ACP | `claude` installed |

Configure in `~/.abtars/config/transport.json`. The onboard wizard sets this up interactively.

## Post-install verification

See [Health Check](./healthcheck.md) for detailed commands.

```bash
abtars status           # should show bridge: ● running
abtars doctor           # should show all green
```

Send a message to your bot on Telegram — it should respond.

## Migrating / Restoring

To restore from a backup (e.g. new machine or after a wipe):

```bash
abtars restore ~/path/to/abtars-backup.zip
abmind restore --input ~/path/to/abmind-backup.abm --passphrase "your-passphrase" --username "your-name"
abtars restart --cold
```

See [Backup & Restore](./backup.md) for details.

## Updating

```bash
npm update -g abtars abmind
abtars update
```

## Platform-specific notes

### Linux (systemd)

Daemon mode installs `/etc/systemd/system/abtars.service`:
```bash
sudo systemctl status abtars
sudo systemctl restart abtars
```

### macOS (launchd)

Daemon mode installs `/Library/LaunchDaemons/com.abtars.daemon.plist`:
```bash
sudo $(which abtars) daemon stop
sudo $(which abtars) daemon start
```

### WSL

Ensure systemd is enabled in `/etc/wsl.conf`:
```ini
[boot]
systemd=true
```

## Troubleshooting

See [Health Check](./healthcheck.md) and [Troubleshooting](./troubleshooting.md).

<!-- test 1780584552 -->

<!-- force-1780586373 -->
