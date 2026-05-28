# Installation

See the full [installation guide](https://github.com/aksika/abtars/blob/dev/docs/install.md) on GitHub.

## Quick install

```bash
git clone git@github.com:aksika/abtars.git
cd abtars
npm install && npm run build
node dist/cli/abtars.js install
abtars update
abtars start
```

If `abtars update` shows a systemd warning, run:
```bash
systemctl --user daemon-reload && systemctl --user restart abtars-watchdog
```

## Requirements

- Node.js 22+
- A Telegram bot token (from @BotFather) or Discord bot token
- At least one model provider configured in `transport.json`

## Providers

abTARS supports multiple model providers out of the box:

| Provider | Transport | Setup |
|----------|-----------|-------|
| ollama | API | `ollama serve` locally, free |
| OpenRouter | API | API key in `.env` |
| Kiro CLI | CLI (ACP) | `kiro-cli` installed |
| Gemini CLI | CLI (ACP) | `gemini` installed |

Configure in `~/.abtars/config/transport.json`.
