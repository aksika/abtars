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
npm install -g abtars@alpha abmind@alpha
abmind install
abtars install
abtars update
abtars onboard
sudo $(which abtars) daemon install
```

Full installation guide: **[docs/wiki/install.md](docs/wiki/install.md)**

## Documentation

Docs live in the repo at **[docs/wiki/](docs/wiki/)** — always up to date with the code.

- [Installation](docs/wiki/install.md)
- [Configuration](docs/wiki/commands.md)
- [Commands](docs/wiki/cli.md)
- [Memory System (abmind)](https://github.com/aksika/abmind)
- [Skills & Extensions](docs/wiki/skills.md)
- [Deployment & Supervision](docs/wiki/supervision.md)

> **Note:** The [aksika.github.io](https://aksika.github.io/abtars/) site may be outdated. Always refer to the docs in this repo.

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
