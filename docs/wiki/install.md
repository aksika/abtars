# Installation

## Requirements

- Node.js 22+
- Git
- A Telegram bot token (from @BotFather) or Discord bot token
- At least one model provider (ollama, OpenRouter, Kiro CLI, or Gemini CLI)

## Quick install

```bash
# 1. Clone the repo
git clone git@github.com:aksika/abtars.git
cd abtars

# 2. Build
npm install && npm run build

# 3. Install
node dist/cli/abtars.js install --mode=supervised-daemon

# 4. Add to PATH (if not already)
export PATH="$HOME/.local/bin:$PATH"
# Add to ~/.bashrc or ~/.zshrc to persist:
#   echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

# 5. Interactive setup (Telegram token, chat ID, model provider)
abtars onboard

# 6. Start
abtars start
```

## Post-install verification

```bash
abtars status    # should show "running"
abtars doctor    # should show all green
abtars logs      # tail the live log
abtars config    # verify your .env (secrets redacted)
```

## Install modes

| Mode | Watchdog | Auto-start on boot | OS service |
|------|----------|--------------------|----|
| `simple` | No | No | None |
| `supervised` | Yes | No (manual `abtars start`) | None |
| `supervised-daemon` | Yes | Yes | systemd (Linux) / launchd (macOS) |

## What gets created

```
~/.abtars/
├── config/          # .env, transport.json, peers.json
├── current/         # symlink → active release
├── releases/        # versioned bundles
├── logs/            # bridge-YYYY-MM-DD.log
├── scripts/         # watchdog.sh, doctor.sh
├── workspace/       # agent working directory
└── bridge.pid       # PID of running bridge
~/.abmind/
└── memory/          # memory.db (auto-created on first bridge start)
```

abmind is bundled as an npm dependency — no separate install needed. The memory database is initialized automatically when the bridge starts for the first time.

## Providers

| Provider | Transport | Setup |
|----------|-----------|-------|
| ollama | API | `ollama serve` locally, free |
| OpenRouter | API | API key in `.env` |
| Kiro CLI | CLI (ACP) | `kiro-cli` installed |
| Gemini CLI | CLI (ACP) | `gemini` installed |

Configure in `~/.abtars/config/transport.json`.

## Updating

```bash
cd ~/abtars && git pull && npm install && npm run build
abtars update --from-local
```

Or from a running bridge: send `/restart` in Telegram.

## Platform-specific notes

### Linux (systemd)

The watchdog runs as a systemd user service (`abtars-watchdog.service`). If it warns:
```bash
systemctl --user daemon-reload
systemctl --user restart abtars-watchdog
```

### macOS (launchd)

The watchdog runs via launchd (`com.abtars.watchdog.plist`). To stop/start:
```bash
abtars stop --force    # --force required (launchd would respawn otherwise)
abtars start
```

## Troubleshooting

**`abtars: command not found`** — `~/.local/bin` is not on your PATH. Add it:
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

**`npm install` fails** — make sure you have Node.js 22+. Run `node --version` to check.

**EADDRINUSE on start** — a stale process is holding the port:
```bash
abtars stop --force
abtars start
```

**Memory DB missing** — `~/.abmind/memory/memory.db` is created automatically on first bridge start. If it's missing after install, start the bridge once and it will initialize.

Run `abtars doctor --fix` for automatic repair of common issues.
