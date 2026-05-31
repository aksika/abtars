# Installation

## Requirements

- Node.js 22+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather)) or Discord bot token
- At least one model provider (ollama, OpenRouter, Kiro CLI, Gemini CLI, Codex, or Claude Code)

## Install

```bash
npm install -g abtars
abtars install
abtars onboard
abtars start
```

That's it. The bridge is running and responding to messages.

### What each step does

| Step | What happens |
|------|-------------|
| `npm install -g abtars` | Installs the CLI globally |
| `abtars install` | Creates `~/.abtars/` with config, scripts, skills |
| `abtars onboard` | Interactive setup: Telegram token, model provider, user ID |
| `abtars start` | Starts the bridge (with watchdog if supervised mode) |

## Add persistent memory (optional)

By default, abtars runs without persistent memory — it responds to messages but forgets between sessions. To add memory:

```bash
npm install -g abmind
abmind install
abtars restart
```

After restart, the bridge has:
- Persistent recall across sessions
- Overnight sleep maintenance (fact extraction, consolidation)
- Emotion tagging and memory promotion
- Searchable memory via tools

## Install modes

| Mode | Watchdog | Auto-start on boot | Best for |
|------|----------|--------------------|----------|
| `simple` | No | No | Testing, development |
| `supervised` | Yes | No | Manual start, crash recovery |
| `supervised-daemon` | Yes | Yes | 24/7 production |

Set during `abtars install --mode=<mode>` or change later in config.

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

```bash
abtars status    # should show "running"
abtars doctor    # should show all green
```

Send a message to your bot on Telegram — it should respond.

## Updating

```bash
npm update -g abtars
abtars update
```

Or from a running bridge: send `/restart` in Telegram.

## Development install (from git)

For contributors or running from source:

```bash
git clone git@github.com:aksika/abtars.git
cd abtars
npm install
abtars install --mode=supervised
abtars update --from-local
abtars onboard
```

`--from-local` builds the bundle automatically (esbuild + assets) and stages it as a release. No manual build step needed.

To update after pulling new commits:

```bash
git pull
abtars update --from-local
```

This rebuilds and hot-restarts the bridge in one command.

## Platform-specific notes

### Linux (systemd)

Supervised-daemon mode installs `abtars-watchdog.service`:
```bash
systemctl --user status abtars-watchdog
systemctl --user restart abtars-watchdog
```

### macOS (launchd)

Supervised-daemon mode installs `com.abtars.watchdog.plist`:
```bash
abtars stop --force    # --force required (launchd respawns otherwise)
abtars start
```

## Troubleshooting

**`abtars: command not found`** — npm global bin not on PATH:
```bash
echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

**`npm install` fails on native deps** — this is fine. abtars works without native modules. Memory features need `abmind install` separately.

**EADDRINUSE on start** — stale process holding the port:
```bash
abtars stop --force && abtars start
```

**No memory tools available** — run `abmind install` then `abtars restart`.

Run `abtars doctor --fix` for automatic repair of common issues.
