# AgentBridge

A personal AI agent that runs on your machine, talks to you via Telegram/Discord, and works in your codebase. Cost-effective access to frontier AI models through existing subscriptions — no per-token billing.

## Why AgentBridge

AI subscriptions give you access to the best models at a fixed monthly cost — but they're locked behind web UIs and CLIs with limited automation. AgentBridge turns those subscriptions into a fully autonomous agent:

- **AWS Builder ID** (free) or enterprise account → Claude Sonnet via [Kiro CLI](https://kiro.dev)
- **Google account** (free/paid) → Gemini 2.5 Pro via [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- **9Router / OpenRouter** → 40+ models including free tiers (Qwen, DeepSeek, Kimi K2)

The bridge is the agent brain — it owns memory, personality, tools, and context management. The CLIs are just model access wrappers. Switch models by changing a config flag, not rewriting your agent.

```
You (Telegram/Discord)
  │
  ▼
AgentBridge (agent brain)
  ├── Memory system (SQLite, 4-layer recall, embeddings)
  ├── Personality (SOUL.md, skills, agent notes)
  ├── Tools (browse, store, recall, edit, sleep cycle)
  ├── Context window management (own compaction, graduated thresholds)
  │
  ├── kiro-cli     → Claude Sonnet (AWS subscription)
  ├── gemini-cli   → Gemini 2.5 Pro (Google free tier)
  └── direct API   → any OpenAI-compatible endpoint (planned)
```

No web server, no exposed ports, no webhooks. Outbound-only traffic to Telegram's API + local communication with the model provider. Optionally, a localhost-only web dashboard can be enabled with `--web`.

## Supported Transports

- **ACP** (recommended) — communicates with kiro-cli or gemini-cli via Agent Client Protocol (JSON-RPC 2.0 over stdio). Real-time streaming, structured permission handling.
- **tmux** (legacy) — runs kiro-cli in a tmux session, communicates via `send-keys` / `capture-pane`. Battle-tested, survives disconnects.
- **Direct API** (planned) — talks to any OpenAI-compatible endpoint directly. No CLI dependency. Tool-calling loop built into the bridge.

## Prerequisites

- **Node.js 22+**
- **tmux** installed (`apt install tmux` or `brew install tmux`)
- **Kiro CLI** installed and in your PATH — verify: `kiro-cli --version`
- **A Telegram Bot** — created via [@BotFather](https://t.me/BotFather)
- **Your Telegram User ID** — get it from [@userinfobot](https://t.me/userinfobot)

Optional: ollama (embeddings), mcporter (MCP), gws (Gmail), nlm (NotebookLM). See [docs/INSTALL.md](docs/INSTALL.md) for full setup.

## Quick Start

### 1. Clone and install

```bash
git clone <repo-url>
cd agentbridge
npm install
```

### 2. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 3. Get your Telegram user ID

1. Message [@userinfobot](https://t.me/userinfobot) on Telegram
2. It replies with your numeric user ID (e.g. `987654321`)

### 4. Configure

```bash
mkdir -p ~/.agentbridge
cp .env.example ~/.agentbridge/.env
```

Edit `~/.agentbridge/.env`:

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
ALLOWED_USER_IDS=987654321
KIRO_TRANSPORT=tmux
WORKING_DIR=/path/to/your/project
TRUST_MODE=true
```

### 5. Build

```bash
npm run build
```

### 6. Deploy and start

```bash
chmod +x scripts/deploy.sh

# Full deploy: build + env sync + steering + launcher + restart tmux
./scripts/deploy.sh

# Quick deploy: env + steering + launcher only (skip build, skip tmux restart)
./scripts/deploy.sh --quick
```

Use `--quick` after config or steering changes when you don't need a rebuild or tmux restart.

### 7. Start the bridge

**Option A — Launcher script (from anywhere):**

```bash
~/.agentbridge/agentbridge.sh                # Discord (default)
~/.agentbridge/agentbridge.sh --telegram     # Telegram only
~/.agentbridge/agentbridge.sh --all          # Both platforms
~/.agentbridge/agentbridge.sh --all --web    # Both platforms + web dashboard
~/.agentbridge/agentbridge.sh stop           # Stop everything
```

The launcher handles nvm, starts the tmux/kiro-cli session if needed, and runs the bridge.

**Option B — Manual (from project directory):**

```bash
cd /home/qakosal/workspace/agentbridge

# 1. Build TypeScript
npm run build

# 2. Start the tmux session (if not already running)
./scripts/tmux-session.sh

# 3. Start the bridge
npm start -- --discord      # or --telegram, --all
```

Dev mode (no build step):

```bash
npm run dev -- --telegram
```

## Web Dashboard

An optional operations dashboard for monitoring and controlling the bridge from your browser.

### Setup

1. Generate an auth token:

```bash
openssl rand -hex 32
```

2. Add to your `.env`:

```env
WEB_AUTH_TOKEN=<your-generated-token>
```

3. Start with `--web`:

```bash
npm run build
npm start -- --telegram --web
# or with --all (enables telegram + discord + web)
npm start -- --all
```

Dev mode (no build step):

```bash
npm run dev -- --telegram --web
```

4. Open `http://localhost:3000` in your browser. Enter your token when prompted.

### What it shows

- Bridge health and uptime
- Platform status (Telegram, Discord) with start/stop toggles
- Transport mode (tmux/ACP) with live switch
- Memory system stats and keyword search (L1–L4 layers)
- Heartbeat status

Real-time updates via WebSocket — no polling.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_AUTH_TOKEN` | — | Required when `--web` is enabled |
| `WEB_PORT` | `3000` | HTTP server port |
| `WEB_HOST` | `127.0.0.1` | Bind address (localhost only by default) |
| `WEB_PUSH_INTERVAL_MS` | `5000` | WebSocket push interval |

## Usage

Message your bot on Telegram:

- **Any text** — forwarded to Kiro as a prompt
- **`/new`** or **`/reset`** — start a fresh Kiro session
- **`/status`** — check transport connection status

## Transport Modes

### tmux (default)

Kiro CLI runs inside a persistent tmux session. The bridge sends your messages via `tmux send-keys` and reads Kiro's responses via `tmux capture-pane`.

Pros: works today, battle-tested, survives disconnects
Cons: output parsing is heuristic-based, no structured permission handling

```env
KIRO_TRANSPORT=tmux
TMUX_SESSION=kiro-bridge
TMUX_CAPTURE_DELAY_SEC=3
TMUX_MAX_WAIT_SEC=300
```

### ACP (experimental)

Communicates with `kiro-cli acp` via JSON-RPC 2.0 over stdio. Structured protocol with typed messages.

Pros: real-time streaming, structured permission requests, clean API
Cons: ACP protocol is young — currently has deserialization issues

```env
KIRO_TRANSPORT=acp
KIRO_CLI_PATH=kiro-cli
```

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | yes | — | Bot token from @BotFather |
| `ALLOWED_USER_IDS` | yes | — | Comma-separated Telegram user IDs |
| `KIRO_TRANSPORT` | no | `tmux` | Transport: `tmux` or `acp` |
| `KIRO_CLI_PATH` | no | `kiro-cli` | Path to kiro-cli binary |
| `WORKING_DIR` | no | `.` | Directory where Kiro operates |
| `TMUX_SESSION` | no | `kiro-bridge` | tmux session name (tmux transport) |
| `TMUX_CAPTURE_DELAY_SEC` | no | `3` | Seconds before first output capture |
| `TMUX_MAX_WAIT_SEC` | no | `300` | Max seconds to wait for Kiro response |
| `TRUST_MODE` | no | `false` | Auto-approve Kiro actions |
| `BROWSING_AGENT` | no | `claude-sonnet-4.6` | Model for browse subagent |
| `PERMISSION_TIMEOUT_MS` | no | `60000` | Permission prompt timeout (acp only) |
| `LOG_LEVEL` | no | `low` | Logging: `off`, `low`, `debug` |
| `WEB_AUTH_TOKEN` | when `--web` | — | Bearer token for dashboard auth |
| `WEB_PORT` | no | `3000` | Dashboard HTTP port |
| `WEB_HOST` | no | `127.0.0.1` | Dashboard bind address |
| `WEB_PUSH_INTERVAL_MS` | no | `5000` | WebSocket status push interval (ms) |

All configuration is read from `~/.agentbridge/.env`. Logs are written to `~/.agentbridge/bridge.log`.

## Security

- Fail-closed: empty user whitelist = refuses to start
- Silent rejection: unauthorized users get no response
- Zero network surface: no webhooks, no exposed ports (web dashboard binds to localhost only)
- No API keys in code: all secrets in `.env`
- No MCP: uses local communication only

## Development

```bash
npm test              # Run tests
npm run test:watch    # Watch mode
npm run typecheck     # Type-check (catches errors Vitest ignores)
npm run build         # Build
```

## Project Structure

```
src/
├── main.ts                          # Entry point — transport selection + wiring
├── types/
│   ├── index.ts                     # Re-exports
│   ├── config.ts                    # Config type with transport settings
│   ├── session.ts, acp.ts, permission.ts, telegram.ts
└── components/
    ├── kiro-transport.ts            # IKiroTransport interface
    ├── tmux-client.ts               # tmux transport implementation
    ├── acp-client.ts                # ACP JSON-RPC client
    ├── acp-transport.ts             # ACP transport adapter
    ├── config.ts                    # .env loading and validation
    ├── security-gate.ts             # User ID whitelist
    ├── telegram-api.ts              # Telegram Bot API wrapper
    ├── telegram-poller.ts           # Long-poll loop
    ├── response-formatter.ts        # Response chunking
    ├── jsonrpc.ts                   # JSON-RPC utilities (acp)
    ├── session-manager.ts           # Session mapping (acp)
    └── permission-handler.ts        # Permission flow (acp)
scripts/
    └── tmux-session.sh              # Start kiro-cli in tmux
```

## License

MIT
