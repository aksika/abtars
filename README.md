# abTARS

**Meet the latest kid on the block.** An agentic framework designed to survive — and do the job.

abTARS is an autonomous AI agent that runs 24/7 on your hardware. It talks to you via Telegram, Discord, or IRC. It remembers everything. It recovers from failures without intervention. It coordinates with peer instances across machines. Your hardware, your rules, zero cloud dependency.

## Built on the CIA Triad

### Confidentiality — classified, encrypted, compartmented

- **NATO-style memory classification** — 4 tiers (UNCLASSIFIED → SECRET), role-gated access
- **Encryption at rest** — AES-256 on memory database, derived key from master passphrase
- **Secrets vault** — isolated directory, 600 perms, never exposed to model context
- **Signed peer comms** — Ed25519 digital signatures on inter-agent channels
- **Injection scanning** — untrusted peer payloads scanned before execution

### Integrity — verified, consistent, self-correcting

- **Peer trust levels** — trust=0 (full scan + sandbox) to trust=3 (direct execution)
- **Memory contradiction detection** — old facts auto-expire when corrected
- **Atomic state** — crash-safe writes, self-healing lock files, no corrupt state survives
- **Doctor** — validates PIDs, DB integrity, FTS health, permissions, TLS identity
- **Single source of truth** — unified bridge.lock, never deleted, always consistent

### Availability — always up, always recovers

- **3-legged supervision** — watchdog → bridge, OS supervisor → watchdog, circuit breaker → rollback
- **Auto-rollback** — bad deploy detected in ~30s, previous version restored automatically
- **Self-healing** — corrupt/missing state files recreated, bridge respawned without intervention
- **Stress-tested** — kill watchdog, kill bridge, corrupt state, deploy garbage — recovers every time
- **Darkwake-aware** — no false kills during sleep, correct resume classification

### + Distributed Agent Swarm

- **Multi-instance** — abTARS instances discover each other, delegate work, share results
- **Gossip health** — UDP broadcast (HMAC-signed), load-based routing
- **Capability discovery** — auto-detect what each peer can do, route accordingly
- **Artifact transfer** — files flow between peers inline or via S3
- **Async delegation** — fire tasks at peers, get callbacks when done

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
  ├── gemini-cli      → Gemini 2.5 Pro/Flash (free tier)
  ├── Direct API      → ollama, OpenRouter, any OpenAI-compatible
  │
  └── Peer Network (gossip + HTTP delegation + callbacks)
```

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
- [Resilience & Stress Tests](docs/wiki/resilience.md)

Full docs: **[aksika.github.io/abtars](https://aksika.github.io/abtars/)**

## Numbers

- 1049+ tests (abtars) + 778 tests (abmind)
- 8 stress-tested failure scenarios with verified auto-recovery
- 5 agent types (professor, dreamy, browsie, coding, cron)
- 3-legged supervision stack (watchdog, OS supervisor, circuit breaker)
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
