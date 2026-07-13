# abTARS

**Meet the latest kid on the block.** An agentic framework designed to survive — and do the job.

abTARS is an autonomous AI agent framework that runs 24/7 on your hardware. It connects frontier models to chat platforms, manages persistent memory, executes tasks on schedule, self-heals from failures, and coordinates work across a distributed swarm of peer instances. Zero cloud dependency. Your rules.

## Design Philosophy: CIA Triad

Every feature in abTARS maps to one of three pillars:

**Confidentiality** — Your data stays classified. NATO-style memory tiers, AES-256 encryption at rest, secrets vault with strict permissions, Ed25519 signed peer communications, injection scanning on untrusted payloads.

**Integrity** — The system never lies about its state. Peer trust levels gate execution depth. Memory contradictions auto-resolve (old facts expire). Atomic writes prevent corruption. Doctor validates everything continuously.

**Availability** — It runs, it recovers, it never stays down. Three-legged supervision (watchdog → bridge, OS → watchdog, circuit breaker → rollback). Bad deploys auto-rollback in ~30s. Corrupt state self-heals. Stress-tested: kill any component, it comes back.

→ [Resilience & Stress Tests](/abtars/resilience)

## Plus: Distributed Agent Swarm

abTARS instances find each other via gossip, delegate work based on capabilities and load, transfer artifacts, and deliver results via callbacks. One agent is useful. A swarm is unstoppable.

→ [Agent Swarm](/abtars/agent-swarm)

## Plus: Pi Integration

abTARS integrates Pi as a symbiotic peer — Pi's provider engine powers Direct API with ~36 providers and prompt caching, Pi's TUI gives you a terminal face, and Pi's coding agent runs supervised coding tasks. Additive, reversible, zero coupling.

→ [Pi Integration](/abtars/pi)

## Features

- **Multi-platform** — Telegram, Discord, IRC (more coming)
- **Multi-provider** — ollama, OpenRouter, Kiro CLI, Gemini CLI, Codex
- **Automatic fallback** — leaky-bucket health tracking, progressive backoff
- **Persistent memory** — powered by abmind (in-process, multi-layer recall)
- **Secrets vault** — AES-256-GCM encrypted at rest, passphrase-derived key
- **Scheduled tasks** — cron-style with retry, logging, notifications
- **Peer-to-peer** — A2A protocol over Tailscale (JWT + digital signatures)
- **Skills** — self-organizing procedural knowledge the agent learns during sleep
- **3-legged supervision** — auto-recovery from crashes, bad deploys, and corruption
- **Auto-rollback** — broken code detected in 30s, previous version restored

→ [Installation guide](/abtars/install)

## Community

- **Discord:** [Join our server](https://discord.gg/pj2qbWJT8)
- **Email:** aksikatwo@gmail.com
- **GitHub:** [aksika/abtars](https://github.com/aksika/abtars) · [aksika/abmind](https://github.com/aksika/abmind)
