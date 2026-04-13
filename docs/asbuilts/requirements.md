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
| 15 | **Persistent personality** | SOUL.md, agent notes, core knowledge, skills. Consistent identity across sessions. Wake-up context rebuilds who the agent is after every restart. |
| 16 | **Cost-effective model access** | Use existing subscriptions (AWS Builder ID, Google, OpenRouter free tier) instead of per-token billing. Bridge turns subscription CLIs into an autonomous agent. |
| 17 | **Coding mode** | Dedicated coding agent (Cody) with project context, separate session. /coding to switch, /default to return. A working mode, not just chat. |
| 18 | **Scheduled tasks** | Cron system with heartbeat-driven execution. Reminders, stock checks, daily routines. Agent can schedule its own tasks at runtime via tool calls. |
| 19 | **Browser capability** | Headless browsing via Browsie subagent. Navigate, extract, screenshot. Docker container with auto-stop after idle. Web research without leaving the conversation. |
| 20 | **Knowledge base integration** | NotebookLM (NLM) as Layer 6 recall. Topic files. ClawHub community skills. External knowledge sources plugged into the memory hierarchy. |
| 21 | **Skill system** | Markdown-based skills in persona/skills/. Hot-reloaded via skill-watcher. Injection scanner on install. Agent learns new capabilities without restart. ClawHub for community distribution. ISkillSlot interface enables future swap to MCP-backed skill server (remote discovery, dynamic tool registration, shared skills across agents). |
| 22 | **Heartbeat subsystem** | 5-minute tick drives everything: task scheduling, standby detection, watchdog kick, session lifecycle. Registered tasks execute per tick. Bridge.lock updated every tick as health signal. Single loop, no competing timers. ITaskSlot interface enables future swap to message queue (priority, retry, persistence). |
