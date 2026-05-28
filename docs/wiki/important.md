# Important Notes

Stability and compatibility information for deploying abTARS in production.

## Tested Configurations

### Platform (messaging interface)

**Telegram** is the primary and most extensively tested platform. All commands, session management, streaming, multi-user features, and edge cases are validated against Telegram. It is the recommended interface for production use.

Discord and IRC adapters are functional but receive less continuous testing.

### Transport (model providers)

Extensively tested with **API-style providers** (ollama, OpenRouter) and **CLI transports** (Kiro CLI). This combination delivers the most stable and predictable results.

For best results, use intelligent paid models (e.g. Claude, GPT-4o, Gemini Pro via OpenRouter). Free-tier models frequently hit rate limits or produce inconsistent output. abTARS handles this with a sophisticated fallback and resilience system — leaky-bucket health tracking, progressive backoff, automatic provider rotation — plus a stable `/emergency` mode that guarantees a working model is always available regardless of upstream failures.

### Operating System

- **macOS** — extensively tested (production deployment on Mac mini)
- **Ubuntu / Ubuntu-based WSL** — extensively tested (production deployment on WSL2)

These are the recommended platforms. Other Linux distributions should work but are not continuously validated.

## Production-Proven Features

### Process Supervision (Watchdog)

The 4-layer watchdog system is extensively tested for resilience:

- **L1** — Transport heartbeat (connection-level health)
- **L2** — In-process 60s stale-elapsed timer (detects frozen event loop)
- **L3** — External watchdog script (detects process crash)
- **L4** — OS-level supervisor (launchd on macOS, systemd on Linux)

This system has been hardened over weeks of production use and handles crash recovery, network drops, and hung processes automatically.

### Memory (abmind)

The abmind integration provides persistent episodic memory, automatic recall, and sleep/dream consolidation. It is stable and production-tested with SQLite (WAL mode) handling concurrent access across multiple deployments sharing the same database.

### Agent Swarm (Delegation)

::: warning Beta
The async session delegation system (spawning background child agents) is in beta. Core lifecycle works (spawn, check, terminate), but the feature is new and edge cases are still being discovered. Use in production with awareness that behavior may evolve.
:::

### Mid-Run Steering

Send `/wait <message>` while the agent is working to inject a course correction without interrupting. The message is delivered between tool calls — the model sees `[USER] Wait! <message>` and adjusts its approach without losing work already done.

- `/wait` alone (no message) — model stops and asks what you need
- `/stop` — hard interrupt, kills the current generation entirely
- Works on Direct-API transport (true mid-run injection between tool rounds)
- On ACP transport: best-effort (injected after current run completes)

### Peer-to-Peer (A2A)

Peer communication between abTARS instances (e.g. KP ↔ Molty) works via authenticated HTTP. Stable for basic message exchange. Advanced coordination features are under active development.

## Recommendations

| Component | Recommended | Why |
|-----------|-------------|-----|
| Platform | Telegram | Most tested, all features validated |
| Transport | OpenRouter + ollama fallback | Paid models for quality, local for resilience |
| Model | Claude / GPT-4o / Gemini Pro | Intelligent models produce reliable tool use and conversation |
| OS | macOS or Ubuntu (WSL2) | Production-proven, watchdog tested |
| Memory | abmind enabled | Stable, adds personality continuity |
| Supervision | Watchdog enabled (default) | Auto-recovery from all failure modes |
