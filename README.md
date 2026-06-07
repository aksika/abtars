# abTARS

**Autonomous AI agent with persistent memory, self-healing, and peer-to-peer communication. Your hardware, your rules.**

abTARS runs 24/7 on your machine — talks to you via Telegram/Discord/IRC, remembers everything across sessions, executes scheduled tasks, and recovers from failures without intervention. Use frontier models through existing CLI subscriptions at zero marginal cost.

## Why abTARS

- 🧠 **Memory that curates itself** — multi-layer recall (5 search stages + reranking), nightly sleep maintenance, emotion tracking, contradiction detection, Memory Darwinism
- 🛡️ **Self-hosted, defense-in-depth** — classified memory (4 tiers, encrypted at rest), role-based access, injection scanning, secrets vault
- 🔄 **Runs months unattended** — 5-layer supervision, leaky-bucket model fallback, self-healing agent, standby-aware recovery
- 🤝 **Agent-to-agent** — P2P communication with Ed25519 signatures, mDNS wake-up, IRC coordination channels
- 💰 **Zero idle cost** — no LLM calls at rest, CLI subscription parasitism, budget sleep tiers

→ **[Why abTARS vs OpenClaw & Hermes](https://aksika.github.io/abtars/why)**

## Architecture

```
You (Telegram / Discord / IRC / API client)
  │
  ▼
abTARS (bridge)
  ├── abmind (memory — in-process, multi-layer recall, encrypted)
  ├── Skills (core + self-authored during sleep + downloadable)
  ├── Tools (browse, bash, MCP, peer_ask)
  ├── Tasks (cron scheduler + retry + DoD checks)
  ├── Agent Swarm (async background sessions)
  │
  ├── kiro-cli        → Claude, DeepSeek, MiniMax, Qwen (free tier)
  ├── gemini-cli      → Gemini 2.5
  ├── Direct API      → ollama, OpenRouter, any OpenAI-compatible
  └── Peers           → other abTARS instances via /v1/chat/completions
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

After install, configure `~/.abtars/config/.env` with your Telegram bot token and at least one model provider. Full guide: **[docs/wiki/install.md](docs/wiki/install.md)**

## Features

### Memory (abmind)

Standalone package — works with abTARS, Kiro CLI, Gemini CLI, Claude Code, Codex, Hermes, or any MCP client.

- Multi-layer recall: 5 search stages (porter FTS5 → trigram → binary signatures → vector embeddings → entity graph) + 7 post-processing layers (cross-stage penalty, context boost, emotion boost, spacing boost, quality boost, MMR reranking, interference detection)
- Agglutinative language support (Hungarian, Finnish, Turkish) — QWERTZ fallback, substring windows
- 25 emotion types with per-memory scoring, emotional arcs per topic
- 12-step nightly sleep: extract, consolidate, prune, detect contradictions, fix translations
- NATO-inspired classification: confidentiality × trust × integrity × credibility
- AES-256-GCM encrypted secrets vault with auto-redaction from history
- Memory Darwinism — unused memories fade, recalled memories strengthen

### Reliability

- **L1** Heartbeat — standby detection, bridge.lock, task dispatch
- **L2** In-process watchdog — detects stuck event loops
- **L3** External watchdog — catches dead PIDs, stale heartbeats. Circuit breaker prevents restart storms
- **L4** OS supervisor — launchd (macOS) / systemd (Linux) restarts the watchdog itself
- **L5** Preventive daily restart — eliminates memory leaks
- **Model health** — leaky-bucket per model, progressive penalties, arbitrarily long fallback chains
- **Self-healing agent** — diagnoses failed tasks, attempts repair, suspends after 3 failures

### Agent Swarm

Main agent spawns independent background sessions (own context, own tool loop). Results auto-inject into the parent's next prompt. Up to 3 concurrent. `/wait` injects instructions into running sessions.

### Peer-to-Peer

Multiple abTARS instances communicate via OpenAI-compatible `/v1/chat/completions` endpoint. Bearer auth per peer, Ed25519 signatures, mDNS wake-up for firewalled peers, hop-limit loop prevention.

### Security

- Platform-level access: only registered chatId/userId can reach the agent
- Role-based: master/user/guest — commands, tools, memory all gated
- Secrets vault: AES-256-GCM, scrypt-derived key, auto-encrypt on ingest
- Injection scanner on all inbound messages
- SSRF guard on browser agent
- Credential redaction in all logs and exports

## Supported Transports

| Transport | Providers |
|-----------|-----------|
| ACP (recommended) | kiro-cli, gemini-cli |
| Direct API | ollama, OpenRouter, any OpenAI-compatible endpoint |
| Hooks (standalone) | abmind lifecycle hooks on any CLI agent |

## Requirements

- Node.js 22+
- A Telegram bot token (Discord/IRC optional)
- At least one model provider

Optional: ollama + `nomic-embed-text` for memory embeddings.

## Documentation

- [Installation](docs/wiki/install.md)
- [Configuration](docs/wiki/commands.md)
- [CLI Reference](docs/wiki/cli.md)
- [Memory System (abmind)](https://github.com/aksika/abmind)
- [Skills & Extensions](docs/wiki/skills.md)
- [Deployment & Supervision](docs/wiki/supervision.md)

Full docs: **[aksika.github.io/abtars](https://aksika.github.io/abtars/)**

## Numbers

- 1794 tests (abtars 1016 + abmind 778)
- 5 agent types (professor, dreamy, browsie, coding, cron)
- 5-layer supervision stack
- 3 platform adapters + OpenAI-compatible API
- 12-step nightly memory maintenance

## Development

```bash
git clone https://github.com/aksika/abtars.git
cd abtars && npm install && npm run build
npm test
```

## Community

- **Discord:** [Join](https://discord.gg/pj2qbWJT8)
- **GitHub:** [aksika/abtars](https://github.com/aksika/abtars) · [aksika/abmind](https://github.com/aksika/abmind)

## License

Apache-2.0
