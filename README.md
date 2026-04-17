# AgentBridge

A personal AI agent that runs on your machine, talks to you via Telegram/Discord, and works in your codebase. Cost-effective access to frontier AI models through existing subscriptions — no per-token billing.

## Why AgentBridge

AI subscriptions give you access to the best models at a fixed monthly cost — but they're locked behind web UIs and CLIs with limited automation. AgentBridge turns those subscriptions into a fully autonomous agent:

- **AWS Builder ID** (free) or enterprise account → Claude Sonnet via [Kiro CLI](https://kiro.dev)
- **Google account** (free/paid) → Gemini 2.5 Pro via [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- **OpenRouter** → 40+ models including free tiers (Qwen, DeepSeek, Gemma, Kimi K2)
- **ollama** → local models, zero cost, no rate limits

The bridge is the agent brain — it owns memory, personality, tools, and context management. The CLIs are just model access wrappers. Switch models by changing a config file, not rewriting your agent.

```
You (Telegram/Discord)
  │
  ▼
AgentBridge (agent brain)
  ├── Memory system (abmind — SQLite, 4-layer recall, embeddings)
  ├── Personality (SOUL.md, skills, agent notes)
  ├── Tools (browse, store, recall, edit, sleep cycle)
  ├── Context window management (compaction, graduated thresholds)
  │
  ├── kiro-cli     → Claude Sonnet (AWS subscription)
  ├── gemini-cli   → Gemini 2.5 Pro (Google free tier)
  └── Direct API   → ollama, OpenRouter, any OpenAI-compatible endpoint
```

No web server, no exposed ports, no webhooks. Outbound-only traffic to Telegram's API + local communication with the model provider.

## Supported Transports

| Transport | How | Best for |
|-----------|-----|----------|
| **ACP** (recommended) | JSON-RPC 2.0 over stdio with kiro-cli or gemini-cli | Subscription-based models (Claude, Gemini) |
| **Direct API** | HTTP to any OpenAI-compatible endpoint | ollama, OpenRouter, self-hosted |
| **tmux** (legacy) | send-keys / capture-pane with kiro-cli in tmux | Fallback if ACP unavailable |

Configure in `~/.agentbridge/config/transport.json`. See `config/transport.json.example`.

## Prerequisites

**Required:**
- **Node.js 22+**
- **python3** — used by `doctor.sh` for health checks
- **A Telegram Bot** — created via [@BotFather](https://t.me/BotFather)

**Transport (at least one):**
- **Kiro CLI** — ACP transport for Claude models
- **Gemini CLI** — ACP transport for Gemini models
- **ollama** — Direct API transport for local models
- **OpenRouter account** — Direct API transport for cloud models

**Skill dependencies (optional):**
- **ollama** + `nomic-embed-text` — memory embeddings
- **mcporter** — MCP tool server
- **gws** — Gmail integration
- **nlm** — NotebookLM knowledge base

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/aksika/agentbridge.git
cd agentbridge
npm install
```

### 2. Configure

```bash
npm run build
bash scripts/deploy.sh
```

Deploy creates `~/.agentbridge/` with all config files. Edit `~/.agentbridge/.env`:

```env
TELEGRAM_BOT_TOKEN=<from @BotFather>
MAIN_CHAT_ID=<your Telegram user ID>
```

Configure your transport in `~/.agentbridge/config/transport.json` and models in `~/.agentbridge/config/models.json`. See the `.example` files in `config/`.

Configure users in `~/.agentbridge/config/users.json`:

```json
{
  "users": [
    {
      "userId": "you",
      "role": "master",
      "maxClass": 3,
      "tools": ["all"],
      "platforms": { "telegram": 123456789 }
    }
  ]
}
```

### 3. Start

```bash
# Via watchdog (recommended — auto-restarts on crash)
~/.agentbridge/watchdog.sh --all --web --agent &

# Or directly
~/.agentbridge/agentbridge.sh --all
```

Flags: `--telegram`, `--discord`, `--web` (dashboard), `--agent` (REST API), `--all` (everything).

### 4. Health check

```bash
bash scripts/doctor.sh          # diagnose
bash scripts/doctor.sh --fix    # auto-fix safe issues
```

## Web Dashboard

Optional localhost dashboard for monitoring. Enable with `--web`.

```env
WEB_AUTH_TOKEN=<openssl rand -hex 32>
WEB_PORT=3000
WEB_HOST=127.0.0.1
```

Open `http://localhost:3000`, enter your token.

## Commands

Message your bot on Telegram:

| Command | Description |
|---------|-------------|
| `/status` | Bridge health, model, uptime |
| `/models` | Current model + fallbacks |
| `/models change` | Switch model/provider (interactive) |
| `/models status` | All agents with model + provider |
| `/new`, `/reset` | Fresh session |
| `/compact` | Compress context window |
| `/tasks` | Cron task management |
| `/memory` | Memory stats |
| `/help` | All commands |

## External Watchdog

`watchdog.sh` monitors the bridge from outside — catches event loop deadlocks and silent crashes that in-process watchdogs can't detect.

```bash
# Start
~/.agentbridge/watchdog.sh --all --web --agent &

# Graceful restart (e.g. after deploy)
kill -USR1 $(grep -o '"pid":[0-9]*' ~/.agentbridge/watchdog.lock | grep -o '[0-9]*')
```

Features: 6-min stale heartbeat detection, SIGKILL for frozen processes, circuit breaker (3 restarts in 5 min), Telegram notification on kill/restart.

For persistent operation, use the provided LaunchAgent (macOS) or systemd unit (Linux).

## Memory System (abmind)

AgentBridge uses [abmind](https://github.com/aksika/abmind) for persistent memory:

- **Messages** — conversation history with emotion scoring
- **Extracted memories** — facts, preferences, relationships extracted during sleep
- **Core knowledge** — promoted long-term memories
- **Sleep cycle** — nightly extraction, consolidation, darwinism (memory competition)

abmind is a separate repo linked via `npm link` or `file:../abmind` in package.json.

## Development

```bash
npm test              # Run tests
npm run test:watch    # Watch mode
npm run typecheck     # Type-check
npm run build         # Build
npm run dev -- --telegram  # Dev mode (no build step)
```

## License

Apache-2.0
