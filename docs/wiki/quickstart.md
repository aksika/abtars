# Quick Setup Guide

Steps only. For detailed explanations, see [Installation Reference](/abtars/install).

## 1. Create a dedicated user

```bash
# Linux/WSL
sudo useradd -m -s /bin/bash abtars && sudo passwd abtars
su - abtars

# macOS
sudo sysadminctl -addUser abtars -password "<password>" -home /Users/abtars
su - abtars
```

No sudo access for this user. The agent runs shell commands — limit the blast radius.

## 2. Install dependencies

```bash
# Node.js 22+
curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22 && fnm use 22

# Ollama (local models)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull nemotron-3-super    # recommended cloud-capable model
```

## 3. Choose supervision model

| Platform | Recommended |
|----------|-------------|
| macOS | launchd (auto-start + auto-restart) |
| Linux/WSL | systemd user service |
| Manual | `abtars start` in tmux |

The installer configures this automatically.

## 4. Install abmind (memory)

```bash
git clone https://github.com/aksika/abmind.git && cd abmind
npm install && npm run build
node dist/cli/abmind.js install && abmind update
```

## 5. Install abTARS (bridge)

```bash
cd ~ && git clone https://github.com/aksika/abtars.git && cd abtars
npm install && npm run build
node dist/cli/abtars.js install && abtars update
```

## 6. Get a Telegram bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. `/newbot` → pick a name → copy the **bot token**
3. Send any message to your new bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your **chat ID**

## 7. Get model provider credentials

Ollama runs locally (no key needed), but for better results use a paid provider:

| Provider | Get key at | What you get |
|----------|-----------|--------------|
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | Access to Claude, GPT, Gemini, open models |
| OpenAI (Codex) | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | GPT-5.4-mini, GPT-5.5 |
| Google (Gemini) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Gemini 2.5 Flash/Pro |
| Kiro CLI | Install via `npm i -g @anthropic-ai/kiro-cli` | Claude models via CLI |

Pick at least one. Store keys in `~/.abtars/secret/<KEY_NAME>` (chmod 600) after install.

## 8. Onboard

```bash
abtars onboard
```

The wizard asks for: platform (Telegram), bot token, chat ID, provider, model.

## 9. Start

```bash
abtars start
```

## 10. Verify

```bash
abtars doctor
```

Send a message to your bot on Telegram — it should respond.

---

## Post-install cheat sheet

### Customize the agent's personality

Edit `~/.abmind/memory/core/SOUL.md` — this defines who your agent is: name, personality, language, tone. Check [sould.md](https://sould.md) for inspiration and examples.

### Useful chat commands

| Command | What it does |
|---------|-------------|
| `/model` | Switch model/provider on the fly |
| `/status` | Bridge health, uptime, current model |
| `/new` | Start a fresh conversation session |
| `/skill` | Reload skills catalog |
| `/sleep` | Trigger sleep + memory consolidation |
| `/stop` | Shut down the bridge |
| `/help` | Full command list |

### Adding models later

Use `/model` in chat — it walks you through provider → model selection interactively. No file editing needed.

### Updating

```bash
cd ~/abtars && git pull && abtars update
```

Rebuilds, deploys, restarts. Zero downtime.

### Something broke?

```bash
abtars doctor                                    # health check
tail -50 ~/.abtars/logs/bridge-$(date +%F).log   # recent logs
abtars stop && abtars start                      # restart
```

### Where is everything?

```
~/.abtars/
├── config/          .env, transport.json, models.json, users.json
├── secret/          API keys (one file per key, chmod 600)
├── logs/            Daily log files (bridge-YYYY-MM-DD.log)
├── skills/          core/, self/, custom/, downloaded/
├── releases/        Versioned deployments
└── current -> releases/0.1.0-<sha>
```
