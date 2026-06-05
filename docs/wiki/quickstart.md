# Quick Start

Steps only. For detailed explanations, see [Installation](./install.md).

## 1. Install

```bash
npm install -g abtars abmind
```

Requires Node.js 22+. For alpha builds: `npm install -g abtars@alpha abmind@alpha`

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

> ⚠️ **SECURITY WARNING:** When creating your bot with @BotFather, **disable "Allow Groups"** and do NOT make it public. abTARS has access to your machine via `execute_bash`. If your bot is public, anyone who finds it can message it and potentially execute commands. The built-in `users.json` allowlist blocks unknown senders, but defense-in-depth means keeping the bot private at the Telegram level too. Set it to private, and only you should know the bot username.

## 3. Start

```bash
sudo $(which abtars) daemon install
```

Done. Your bot is live on Telegram.

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
npm update -g abtars abmind
abtars update
```

### Stop / restart

```bash
sudo systemctl stop abtars      # stop
sudo systemctl restart abtars   # restart
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
