# Installation

## Requirements

- Node.js 22+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather)) or Discord bot token
- At least one model provider (ollama, OpenRouter, Kiro CLI, Gemini CLI, Codex, or Claude Code)

## Agent install

Give this page to your favourite AI agent (Claude, Gemini, Codex, Kiro) and ask it to install abTARS for you. It has all the information it needs right here. 😉

## Manual install (npm)

```bash
npm install -g abtars abmind
abtars install
abtars update
abtars onboard
sudo $(which abtars) daemon install
```

> **Alpha channel** (latest development builds):
> ```bash
> npm install -g abtars@alpha abmind@alpha
> ```

| Step | What happens |
|------|-------------|
| `npm install -g abtars abmind` | Installs CLI tools globally |
| `abtars install` | Creates `~/.abtars/` skeleton (config, scripts, skills) |
| `abtars update` | Stages the release (copies bundle to `~/.abtars/releases/`) |
| `abtars onboard` | Interactive setup: Telegram token, model, user ID + runs `abmind install` |
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
| Codex | ACP | `codex` installed |
| Claude Code | ACP | `claude` installed |

Configure in `~/.abtars/config/transport.json`. The onboard wizard sets this up interactively.

## Post-install verification

See [Health Check](./healthcheck.md) for detailed commands.

```bash
abtars status           # should show bridge: ● running
abtars doctor           # should show all green
```

Send a message to your bot on Telegram — it should respond.

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
