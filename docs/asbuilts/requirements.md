# AgentBridge — Architecture Requirements

Post-skeleton refactor (#131/#132/#133). These are the non-negotiable properties of the system.

## Requirements

| # | Requirement | Description |
|---|---|---|
| 1 | **Modular skeleton** | Slot-based architecture. Add/replace body parts (memory, sleep, transport, skills, tasks, platforms) via typed interfaces. Config-driven loading. |
| 2 | **Decoupled mind** | abmind is a standalone brain. Memory + sleep pipeline. 3 levels of sleep complexity (full/basic/off). Pluggable via adapters: AB-slot, OC plugin, MCP server, CLI. |
| 3 | **No boilerplate** | `runtime.complete(agent, prompt)` replaces manual transport wiring. Clean interfaces, minimal glue code. Simple maintenance. |
| 4 | **Multi-user ready** | userId flows through skeleton. Memory scoped per user (private/shared). Platform adapters map chatId → userId. Architecture supports it, implementation in #67. |
| 5 | **Multi-platform** | Same brain, same personality, different channels. Telegram, Discord, future platforms. Platform is a slot, not hardwired. |
| 6 | **Model-agnostic** | Switch models/providers without code changes. transport.json + models.json. Hot-switch same provider, restart on provider change. Skeleton doesn't care what LLM is behind runtime.complete(). |
| 7 | **Self-maintaining** | Sleep cycle keeps memory healthy without human intervention. Contradiction checking, promotion/demotion, consolidation, daily summaries. The brain maintains itself — the body just triggers it. |
| 8 | **Secure by default** | Injection scanner on all inputs (14 categories). Fail-closed user whitelist. No exposed ports. Memory scoped. Skills sandboxed. No secrets in code. |
| 9 | **Observable** | /status, /models status, heartbeat, watchdog, bridge.lock, logs. runtime.complete() logging (agent, duration, model). Always know what's happening. |
| 10 | **Emotionally intelligent** | Emotion tagging, scoring, arc tracking. Shapes personality and memory prioritization. Makes the agent human-like. Not a gimmick — core design principle. |
| 11 | **Offline-capable** | SQLite + local Ollama. No cloud dependency for core functions. Cloud models optional (better quality), not required. |
| 12 | **Testable** | Every slot has an interface → mockable. 900+ tests across both repos. Skeleton makes testing easier — mock the runtime, test the component. |
| 13 | **Robust with recovery** | Watchdog (wall-clock, dark wake safe). LaunchAgent restart. Transport fallback (leaky bucket + rollback). DB WAL checkpoint. doctor.sh diagnostics. |
| 14 | **Basic self-healing** | Self-healer task. Transport auto-restore after fallback. Heartbeat health check restores primary. FTS index rebuild. Message dedup. Memory defaults fix. |
