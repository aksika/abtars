# Quick Start

Steps only. For detailed explanations, see [Installation](./install.md).

## 1. Install

```bash
npm install -g abtars@alpha abmind@alpha
```

Requires Node.js 22+. Alpha builds ship frequently with the latest features. For stable releases: `npm install -g abtars abmind`

## 2. Setup

```bash
abtars install
abtars update
abtars onboard
```

The onboard wizard asks for:
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Model provider (Kiro CLI, OpenRouter, ollama, etc.)
- Agent name and passphrase (for memory encryption)

> ⚠️ **SECURITY WARNING:** When creating your bot with @BotFather, keep it **private** (not searchable publicly). abTARS has access to your machine via `execute_bash`. If your bot is publicly discoverable, anyone can find and message it. The built-in `users.json` allowlist blocks unknown senders, but defense-in-depth means the bot should not be discoverable in the first place. Only people who know the exact bot username should be able to reach it.

## 3. Start

```bash
abtars start
```

Done. Your bot is live on Telegram. Runs in the foreground — press Ctrl+C to stop.

To run as a background service (auto-restart, survives reboot):

```bash
abtars daemon install
```

## 4. Verify

```bash
abtars status       # should show bridge: ● running
abtars doctor       # should show all green
```

Send a message to your bot — it should respond.

## Post-install cheat sheet

### Telegram commands

| Command | What it does |
|---------|-------------|
| `/status` | Bridge health, uptime, model |
| `/model` | Switch model/provider on the fly |
| `/new` | Start a fresh conversation session |
| `/sleep` | Trigger sleep + memory consolidation |
| `/restart` | Restart the bridge |
| `/help` | Full command list |

### Customize personality

Edit `~/.abmind/memory/core/SOUL.md` — defines who your agent is: name, personality, language, tone.

### Updating

```bash
npm update -g abtars@alpha abmind@alpha
abtars update
```

### Stop / restart

```bash
abtars stop         # stop (foreground: just Ctrl+C)
abtars start        # start again
```

### Something broke?

```bash
abtars doctor --fix
tail -20 ~/.abtars/logs/bridge-$(date +%F).log
```

See [Health Check](./healthcheck.md) for more.

### Where is everything?

```
~/.abtars/
├── config/          .env, transport.json, models.json, users.json
├── secret/          API keys (encrypted at rest)
├── logs/            Daily log files
├── skills/          core/, self/, custom/
├── releases/        Versioned deployments
└── current → releases/<version>

~/.abmind/
├── memory/core/     SOUL.md, agent_notes.md, user_profile.md
├── memory/memory.db SQLite memory database
└── secret/          Encryption key
```
