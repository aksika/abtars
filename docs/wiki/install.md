# Installation

## Requirements

- Node.js 22+
- Optional: ollama (for vector embeddings — FTS5 + trigram work without it)

## Path 1: npm (recommended)

```bash
npm install -g abtars
abtars install --mode=supervised-daemon
abtars onboard
abtars start
```

## Path 2: From source

```bash
git clone git@github.com:aksika/abtars.git
cd abtars
npm install && npm run build
node dist/cli/abtars.js install --mode=supervised-daemon
abtars update --from-local
abtars onboard
abtars start
```

## What each step does

| Step | What happens |
|------|-------------|
| `install` | Creates `~/.abtars/`, stages release, sets up watchdog |
| `onboard` | Interactive wizard: Telegram token, chat ID, model provider |
| `start` | Launches the bridge (watchdog supervises from here) |

## Install modes

| Mode | Watchdog | Auto-start on boot | OS service |
|------|----------|--------------------|----|
| `simple` | No | No | None |
| `supervised` | Yes | No (manual `abtars start`) | None |
| `supervised-daemon` | Yes | Yes | systemd (Linux) / launchd (macOS) |

## Add memory (optional)

```bash
npm install -g abmind
abmind install
abtars restart
```

Memory features (recall, store, sleep cycles, credential vault) activate on next restart. The bridge works without abmind — it just won't have persistent memory.

## Post-install verification

```bash
abtars status    # should show "running"
abtars doctor    # should show all green
abtars logs      # tail the live log
abtars config    # verify your .env (secrets redacted)
```

## What gets created

```
~/.abtars/
├── config/          # .env, transport.json, models.json
├── current/         # symlink → active release
├── releases/        # versioned bundles
├── logs/            # bridge-YYYY-MM-DD.log
├── scripts/         # watchdog.sh, doctor.sh
├── skills/          # core/ + self/
├── workspace/       # agent working directory
└── bridge.pid       # PID of running bridge
```

## Providers

| Provider | Transport | Setup |
|----------|-----------|-------|
| ollama | API | `ollama serve` locally, free |
| OpenRouter | API | API key in `secret/` |
| Kiro CLI | CLI (ACP) | `kiro-cli` installed |
| Gemini CLI | CLI (ACP) | `gemini` installed |

Configure in `~/.abtars/config/transport.json`. See [Model Management](models.md).

## Updating

**npm install:**
```bash
npm update -g abtars
abtars update
```

**From source:**
```bash
cd ~/abtars && git pull && npm install && npm run build
abtars update --from-local
```

Or from a running bridge: send `/restart` in chat.

## Platform-specific notes

### Linux (systemd)

The watchdog runs as a systemd user service. If it warns:
```bash
systemctl --user daemon-reload
systemctl --user restart abtars-watchdog
```

### macOS (launchd)

The watchdog runs via launchd. To stop/start:
```bash
abtars stop --force    # --force required (launchd would respawn otherwise)
abtars start
```

### WSL

Ensure systemd is enabled in `/etc/wsl.conf`:
```ini
[boot]
systemd=true
```

## Troubleshooting

**`abtars: command not found`** — `~/.local/bin` not on PATH:
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

**EADDRINUSE on start** — stale process holding the port:
```bash
abtars stop --force
abtars start
```

**Memory not working** — install abmind:
```bash
npm install -g abmind && abmind install && abtars restart
```

Run `abtars doctor --fix` for automatic repair of common issues.
