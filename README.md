# abTARS

A personal AI agent that runs on your machine, talks to you via Telegram/Discord/IRC, and remembers everything. Use frontier models through existing subscriptions — no per-token billing.

## What it does

- **Always-on agent** — runs 24/7, responds on Telegram/Discord, executes tasks on schedule
- **Persistent memory** — remembers conversations, learns preferences, extracts facts overnight
- **Multi-model** — Claude, Gemini, OpenRouter (40+ models), ollama (local). Switch by changing config
- **Self-healing** — 4-layer watchdog, auto model fallback, survives crashes and network drops
- **Extensible** — skills system, MCP integration, agent-to-agent communication

```
You (Telegram/Discord/IRC)
  │
  ▼
abTARS (agent brain)
  ├── Memory (abmind — persistent, searchable, encrypted)
  ├── Personality (customizable identity + learned behavior)
  ├── Tools (browse, recall, store, bash, MCP servers)
  ├── Skills (hot-reloadable, self-authoring)
  │
  ├── kiro-cli     → Claude (AWS subscription)
  ├── gemini-cli   → Gemini
  ├── Codex / Claude Code → OpenAI / Anthropic
  └── Direct API   → ollama, OpenRouter, any OpenAI-compatible
```

## Quick Start

```bash
npm install -g abtars
abtars init
```

The init wizard walks you through:
1. Telegram bot token (from [@BotFather](https://t.me/BotFather))
2. Model provider (kiro-cli, gemini-cli, ollama, or OpenRouter)
3. Your user ID

Then start:

```bash
abtars start
```

## Documentation

Full docs, configuration reference, and guides: **[Wiki](https://github.com/aksika/abtars/wiki)**

- [Installation](https://github.com/aksika/abtars/wiki/Installation)
- [Configuration](https://github.com/aksika/abtars/wiki/Configuration)
- [Commands](https://github.com/aksika/abtars/wiki/Commands)
- [Memory System (abmind)](https://github.com/aksika/abmind)
- [Skills & Extensions](https://github.com/aksika/abtars/wiki/Skills)
- [Deployment & Watchdog](https://github.com/aksika/abtars/wiki/Deployment)

## Supported Transports

| Transport | Provider | 
|-----------|----------|
| ACP | kiro-cli, gemini-cli, Codex, Claude Code |
| Direct API | OpenRouter, ollama, any OpenAI-compatible endpoint |
| Hooks | abmind hooks (standalone CLI agents) |

## Requirements

- Node.js 22+
- A Telegram bot token
- At least one model provider (kiro-cli, gemini-cli, ollama, OpenRouter, Codex, or Claude Code)

Optional: ollama + `nomic-embed-text` for memory embeddings.

## Development

```bash
git clone https://github.com/aksika/abtars.git
cd abtars && npm install && npm run build
npm test
```

## License

Apache-2.0
