# Changelog

All notable changes to abTARS. Follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] — 2026-05-31

First public release.

### Core
- **Multi-platform** — Telegram, Discord, IRC with unified message pipeline
- **Multi-provider** — ollama, OpenRouter, Kiro CLI, Gemini CLI, Codex
- **Model management** — fallback chains, health tracking, hot-swap via `/model`
- **Session system** — Main, Browse, Code, Task sessions with concurrent support
- **Context window** — compaction, ABM-L compression, multi-tier assembly
- **Streaming** — SSE streaming for DirectAPI transport

### Memory (via abmind)
- In-process memory integration (optional — bridge boots without it)
- 4-layer recall injected per-turn (active memory)
- Sleep maintenance (Dreamy subagent, 12-step overnight pipeline)
- Credential vault — AES-256-GCM encrypted secrets at rest

### Security
- **Tool sandbox** — per-session policy enforcement (checkTool/checkPath)
- **A2A peer restrictions** — 3-layer defense (whitelist, injection scan, system prompt)
- **Rate limiter** — per-caller sliding window (MAX_AGENT_CALL_PER_HOUR/DAY)
- **Path traversal protection** — symlink resolution, blacklist enforcement
- **Secret auto-migration** — keys in .env.skills auto-moved to secret/
- **Log redaction** — class≥2 secrets never appear in logs

### Lifecycle
- `abtars install` — supervised/supervised-daemon modes, systemd/launchd
- `abtars update` — staged deploy, <2s downtime
- `abtars start/stop/restart` — port-based stale process kill (#686)
- `abtars doctor` — FTS integrity probe, filesystem checks, auto-repair
- `abtars onboard` — interactive setup wizard
- `abtars logs/config/status/backup/rollback` — operational commands
- 4-layer watchdog — in-proc heartbeat, bash watchdog, OS supervisor, circuit breaker

### Platforms
- **Telegram** — polling, inline keyboards, model picker, TTS, image handling
- **Discord** — polling, mention filter, chunking, multi-guild
- **IRC** — multi-channel, retry with backoff, hot-reload config

### Features
- **Skills** — hot-reload from `~/.abtars/skills/`, self-authoring, usage tracking
- **Scheduled tasks** — cron-style with retry, gate scripts, notifications
- **Browser agent** — delegated web browsing via IPC subprocess
- **Peer-to-peer** — A2A protocol, TLS 1.3, JWT auth, digital signatures
- **Self-healer** — log watcher, auto-fix rules, circuit breaker, notification throttling
- **Dashboard** — web UI for status monitoring
- **MCP integration** — tool server support
- **Hooks** — extensible lifecycle hooks system

### CLI
- `abtars install/uninstall/update/rollback/backup`
- `abtars start/stop/restart/status`
- `abtars doctor/onboard/passwd`
- `abtars logs/config`

### Documentation
- Full wiki (29 pages): install, models, commands, sessions, skills, peers, security, resilience
- "How to Add a New Service" guide
- CLI reference
