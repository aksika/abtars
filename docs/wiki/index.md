# abTARS

**A Personal Agentic Framework** — your agent, your hardware, your rules.

Self-hosted AI agents that run autonomously on your own infrastructure. Connect any model to Telegram, Discord, or IRC with persistent memory, scheduled tasks, multi-provider fallback, and peer-to-peer communication.

## Features

- **Multi-platform** — Telegram, Discord, IRC (more coming)
- **Multi-provider** — ollama, OpenRouter, Kiro CLI, Gemini CLI, Codex
- **Automatic fallback** — leaky-bucket health tracking, progressive backoff
- **Persistent memory** — powered by abmind (in-process)
- **Secrets vault** — AES-256-GCM encrypted at rest, passphrase-derived key, auto-encrypt on ingest
- **Scheduled tasks** — cron-style with retry, logging, notifications
- **Peer-to-peer** — A2A protocol over Tailscale (JWT + digital signatures)
- **Dashboard** — real-time web UI for status monitoring
- **Skills** — self-organizing procedural knowledge the agent learns and maintains
- **4-layer watchdog** — auto-recovery from crashes, hangs, and network drops

→ [Installation guide](/abtars/install)

## Community

- **Discord:** [Join our server](https://discord.gg/pj2qbWJT8)
- **Email:** aksikatwo@gmail.com
- **GitHub:** [aksika/abtars](https://github.com/aksika/abtars)
