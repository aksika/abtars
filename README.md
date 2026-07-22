# abTARS

**Meet the latest kid on the block.** An agentic framework designed to survive — and do the job.

abTARS is an autonomous AI agent that runs 24/7 on your hardware. It talks to you via Telegram, Discord, or IRC. It remembers everything. It recovers from failures without intervention. It coordinates with peer instances across machines. Your hardware, your rules, zero cloud dependency.

## Five Layers: Body → Heart → Brain → Soul → Tribe

Each layer builds on the one below it — lower layers work without the higher ones. **Body** boots, connects, and protects itself with nothing else running. **Tribe** — the social layer — needs all four below it.

```
┌─────────────────────────────────────────────┐
│  Tribe     Peer transport, Gossip, A2A,     │
│            Agent API, Agent Swarm           │
├─────────────────────────────────────────────┤
│  Soul      abmind, Soul bundle, Sleep,      │
│            Memory IPC, Context assembly     │
├─────────────────────────────────────────────┤
│  Brain     Model transport, Pipeline, Spin, │
│            Sessions, Tools, Skills, Kanban, │
│            Self-Healer, Pi integration      │
├─────────────────────────────────────────────┤
│  Heart     Heartbeat, Cron queue,           │
│            Health monitoring                │
├─────────────────────────────────────────────┤
│  Body      Platforms (Telegram, Discord,    │
│            IRC), Dashboard, CLI,            │
│            Security/Trust, ActionGate,      │
│            Doctor, Watchdog, Boot, Config   │
└─────────────────────────────────────────────┘
```

## Built on the CIA Triad

The same three security pillars are enforced at every layer, top to bottom:

### Confidentiality — classified, encrypted, compartmented

- **NATO-style memory classification** (Soul) — 4 tiers (UNCLASSIFIED → SECRET), role-gated access
- **Encryption at rest** (Soul) — AES-256 on memory database, derived key from master passphrase
- **Secrets vault** (Body) — isolated directory, 600 perms, never exposed to model context
- **Signed peer comms** (Tribe) — Ed25519 digital signatures on inter-agent channels
- **Injection scanning** (Tribe) — untrusted peer payloads scanned before execution

### Integrity — verified, consistent, self-correcting

- **Peer trust levels** (Tribe) — trust=0 (full scan + sandbox) to trust=3 (direct execution)
- **Memory contradiction detection** (Soul) — old facts auto-expire when corrected
- **Atomic state** (Body/Heart) — crash-safe writes, self-healing lock files, no corrupt state survives
- **Doctor** (Body) — validates PIDs, DB integrity, FTS health, permissions, TLS identity across all five layers
- **Single source of truth** (Body) — unified bridge.lock, never deleted, always consistent

### Availability — always up, always recovers

- **3-legged supervision** (Body) — watchdog → bridge, OS supervisor → watchdog, circuit breaker → rollback
- **Auto-rollback** (Body) — bad deploy detected in ~30s, previous version restored automatically
- **Self-healing** (Brain) — corrupt/missing state files recreated, bridge respawned without intervention
- **Stress-tested** — kill watchdog, kill bridge, corrupt state, deploy garbage — recovers every time
- **Darkwake-aware** (Heart) — no false kills during sleep, correct resume classification

## Plus: Distributed Agent Swarm (Tribe)

One agent is useful. A swarm is unstoppable. abTARS instances discover each other via signed gossip, delegate work by capability and load, transfer artifacts, and deliver results via callbacks — no master, no single point of failure.

- **Multi-instance** — abTARS instances discover each other, delegate work, share results
- **Gossip health** — UDP broadcast (HMAC-signed), load-based routing
- **Capability discovery** — auto-detect what each peer can do, route accordingly
- **Artifact transfer** — files flow between peers inline or via S3
- **Async delegation** — fire tasks at peers, get callbacks when done
- **Orc/Worker delegation** — a coordinating agent breaks work down and fans it out across the swarm

## Plus: Pi Integration (Brain)

abTARS integrates [Pi](https://github.com/earendil-works/pi) as a **symbiotic peer**, not a dependency — each runs standalone, runtime discovery bridges them. Additive and reversible: if a Pi package breaks or is absent, abTARS keeps working unchanged.

- **Provider engine (L1 motor)** — Pi's `pi-ai` unlocks ~36 model providers and prompt caching on the `pi-ai` route
- **Terminal face** — Pi's TUI gives abTARS a terminal interface (`abtars tui`)
- **Supervised coding agent** — Pi's coding agent runs complex coding tasks as a supervised subprocess (`/pi run`)
- **Zero coupling** — no npm dependency either direction; emergency execution is a separate ACP hailMary path owned by #1468

## Architecture

```
You (Telegram / Discord / IRC / API client)
  │
  ▼
abTARS (bridge)
  ├── abmind (Soul — memory, in-process, multi-layer recall, encrypted)
  ├── Skills (core + self-authored during sleep + downloadable)
  ├── Tools (browse, bash, MCP, peer_ask)
  ├── Tasks (cron scheduler + retry + DoD checks)
  ├── Agent Swarm (Tribe — async background sessions, Orc/Worker delegation)
  │
  ├── kiro-cli        → Claude, DeepSeek, MiniMax, Qwen (free tier)
  ├── gemini-cli      → Gemini 2.5 Pro/Flash (free tier)
  ├── pi-ai route     → ollama, OpenRouter, any OpenAI-compatible, Pi's pi-ai (~36 providers)
  ├── Pi              → TUI face, supervised coding agent
  │
  └── Peer Network (Tribe — gossip + HTTP delegation + callbacks)
```

| Transport | Providers |
|-----------|-----------|
| ACP (recommended) | kiro-cli, gemini-cli |
| pi-ai route | ollama, OpenRouter, any OpenAI-compatible endpoint, Pi's pi-ai (~36 providers) |
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
- [Pi Integration](docs/wiki/pi.md)
- [Deployment & Supervision](docs/wiki/supervision.md)
- [Resilience & Stress Tests](docs/wiki/resilience.md)

Full docs: **[aksika.github.io/abtars](https://aksika.github.io/abtars/)**

## Numbers

- 2762 tests (abtars) + 1149 tests (abmind)
- 8 stress-tested failure scenarios with verified auto-recovery
- 5 agent types (professor, dreamy, browsie, coding, cron)
- 5 architectural layers (Body, Heart, Brain, Soul, Tribe)
- ~36 model providers available via Pi's `pi-ai` engine, on top of the always-available hand-rolled floor
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
