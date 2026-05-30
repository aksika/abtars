# Installation

## Requirements

- Node.js 22+
- A Telegram bot token (from @BotFather) or Discord bot token
- At least one model provider configured in `transport.json`

## Quick install

```bash
git clone git@github.com:aksika/abtars.git
cd abtars
npm install && npm run build
node dist/cli/abtars.js install --mode=supervised-daemon
abtars onboard
abtars start
```

## What each step does

1. **install** — creates `~/.abtars/`, deploys the bridge, sets up the watchdog
2. **onboard** — interactive wizard: sets Telegram bot token, chat ID, default model provider
3. **start** — launches the bridge (watchdog supervises it from here)

## Post-install verification

```bash
abtars status    # should show "running"
abtars doctor    # should show all green
abtars logs      # tail the live log
abtars config    # verify your .env (secrets redacted)
```

## Install modes

| Mode | Watchdog | Auto-start on boot |
|------|----------|--------------------|
| `simple` | No | No |
| `supervised` | Yes | No (manual `abtars start`) |
| `supervised-daemon` | Yes | Yes (systemd/launchd) |

## Providers

abTARS supports multiple model providers out of the box:

| Provider | Transport | Setup |
|----------|-----------|-------|
| ollama | API | `ollama serve` locally, free |
| OpenRouter | API | API key in `.env` |
| Kiro CLI | CLI (ACP) | `kiro-cli` installed |
| Gemini CLI | CLI (ACP) | `gemini` installed |

Configure in `~/.abtars/config/transport.json`.

## Updating

```bash
cd ~/abtars && git pull && npm run build
abtars update --from-local
```

Or from a running bridge: send `/restart` in Telegram.

## Troubleshooting

If `abtars start` fails with EADDRINUSE:
```bash
abtars stop --force
abtars start
```

If systemd warns about the watchdog:
```bash
systemctl --user daemon-reload && systemctl --user restart abtars-watchdog
```

Run `abtars doctor --fix` for automatic repair of common issues.
