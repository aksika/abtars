# abTARS

**Autonomous AI bridge — your agent, your hardware, your rules.**

abTARS connects AI models to messaging platforms (Telegram, Discord, IRC) and runs them autonomously with scheduled tasks, multi-provider fallback, persistent memory via abmind, and peer-to-peer agent communication.

## What it does

- Receives messages from Telegram, Discord, or IRC
- Routes them through a configurable model (local ollama, OpenRouter, Kiro CLI, Gemini CLI)
- Manages conversation sessions, context windows, and streaming responses
- Runs scheduled tasks (cron), sleep cycles, and health monitoring
- Falls back automatically when a model is unavailable
- Communicates with other abTARS instances via peer-to-peer A2A protocol

## Quick start

```bash
git clone git@github.com:aksika/abtars.git
cd abtars && npm install && npm run build
node dist/cli/abtars.js install
abtars update
abtars start
```

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
