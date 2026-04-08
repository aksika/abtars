# Kiro Professor — As-Built Documentation

> **Update rules:** This document reflects the CURRENT state of the system. When updating:
> - Never add historical notes ("was X", "changed from Y", "removed Z")
> - Never use strikethrough for deleted components — just remove the row
> - Never annotate with NEW/REMOVED/Unchanged — every line describes what exists NOW
> - If a component is deleted, delete its documentation entirely
> - Refactor history belongs in git commits and backlog, not here

## Overview

Kiro Professor is a standalone Node.js agent that runs on your machine, talks to you via Telegram/Discord, and works in your codebase. Cost-effective access to frontier AI models through existing subscriptions — no per-token billing. The bridge is the agent brain — it owns memory, personality, tools, and context management. The CLIs are just model access wrappers.

Supports three transport modes:
- **ACP** (recommended) — communicates with kiro-cli or gemini-cli via Agent Client Protocol (JSON-RPC 2.0 over stdio)
- **Direct API** — talks to any OpenAI-compatible endpoint directly (9Router, OpenRouter, OpenAI, Ollama). Tool-calling loop built into the bridge. No CLI dependency.
- **tmux** (legacy) — runs kiro-cli in a tmux session, communicates via `send-keys` / `capture-pane`

Optional: localhost web dashboard, local memory system (SQLite + FTS5 + embeddings), sleep maintenance cycle, agent-callable CLI tools, browser automation, scheduled tasks.

For the memory subsystem, see [memory.asbuilt.md](memory.asbuilt.md).

---

## Subsystems

| Subsystem | Description |
|-----------|-------------|
| **Platform Abstraction** | Telegram + Discord adapters behind a shared `PlatformAdapter` interface and unified message pipeline. |
| **Memory** | Standalone `@agentbridge/memory` package (ABM v2). 39 self-contained files, `IMemorySystem` interface, zero bridge dependencies. SQLite + FTS5 + vector embeddings + binary signatures (Hamming search). ABM-L compression, emotion tagging, importance flags, three-tier aging. See [memory.asbuilt.md](memory.asbuilt.md). |
| **Sleep (Dreamy)** | Optional addon — memory works without it. Triggered by BED_TIME + quiet ticks (no restart). 24 sleep steps: retrospective, GC, extraction, consolidation, topic assignment, core promotion, temporal review, emotion/flags backfill, ABM-L compression, contradiction check, emotional arcs, memory aging, entity review, skill review. After success: optional Mac hardware sleep (`pmset sleepnow`). See [memory.asbuilt.md](memory.asbuilt.md). |
| **Tasks** | Time-based scheduling for reminders and agent tasks. SQLite storage, sequential queue, priority levels, retry. User-facing: `/tasks`. CLI: `agentbridge-task`. |
| **Todo** | File-based todo list (`todo.md`). Agent-managed via `agentbridge-todo` CLI. |
| **Browser (Browsie)** | Detached browser subagent. Headless Chromium in Docker, autonomous navigation, non-blocking. SSRF protection blocks private IPs. |
| **Self-Healer** | Heartbeat task scanning `bridge.log` for errors, injecting bug reports to KP via Telegram. |
| **A2A (Agent API)** | HTTP API for peer agents (Molty). HMAC challenge-response auth, consulting-only relationship. |
| **Dashboard** | Localhost web UI: platform status, cron panel, log viewer, memory stats, 3D memory visualization. |
| **Doctor** | `doctor.sh` — startup diagnostics + safe auto-repair (permissions, stale locks, FTS rebuild). |
| **Deploy** | `deploy.sh` — builds, copies CLIs/skills/prompts/tasks to `~/.agentbridge/`, manages tmux session. |

---

## Platform Abstraction

### Overview

All messaging platforms implement the `PlatformAdapter` interface. A shared `handleInboundMessage()` pipeline processes messages identically regardless of source. Adding a new platform (Slack, WhatsApp) is ~100 lines implementing the adapter.

### Architecture

```
Telegram/Discord → PlatformAdapter.start() → onMessage callback
  → handleInboundMessage(msg, adapter, deps)
    → voice STT → command check → prompt build
    → transport.sendPrompt() → streaming → response delivery
    → memory persist → TTS → auto-compact
```

### Key Types (`src/types/platform.ts`)

- `PlatformAdapter`: `name`, `capabilities`, `start()`, `stop()`, `authorize()`, `sendMessage()`, `chunkResponse()`, optional `sendTyping()`, `setReaction()`, `downloadVoice()`, `sendVoice()`, `injectMessage()`
- `InboundMessage`: `text`, `chatId`, `userId`, `platform`, `messageId`, `isVoice?`, `voiceFileId?`, `isGroup?`
- `PlatformCapabilities`: `voice`, `reactions`, `typing`, `tts`, `groups`

### Adapters

| Adapter | Source | Capabilities |
|---------|--------|-------------|
| `TelegramAdapter` | `src/platforms/telegram/telegram-adapter.ts` | voice, reactions, groups, typing, TTS |
| `DiscordAdapter` | `src/platforms/discord/discord-adapter.ts` | reactions (emoji scoring), A2A, mention stripping |

### Message Pipeline (`src/components/message-pipeline.ts`)

`handleInboundMessage()` — shared flow for all platforms. Early phases (voice, commands, busy guard) run as middleware via `runPipeline()`. Core transport/response handling inline. Dependencies injected via `PipelineDeps` (composed from `TransportDeps`, `MemoryDeps`, `VoiceDeps`, `SessionState`).

### Middleware (`src/components/pipeline/`)

| Middleware | File | Purpose |
|---|---|---|
| `voiceMiddleware` | `pipeline/voice.ts` | STT transcription |
| `commandMiddleware` | `pipeline/commands.ts` | Slash commands + transport commands |
| `busyGuardMiddleware` | `pipeline/busy-guard.ts` | Queue messages when transport is busy |

Adding a message behavior: create a middleware in `pipeline/`, add to the chain in `handleInboundMessage()`.

### Extracted Components

| Component | Source | Purpose |
|-----------|--------|---------|
| `CodingMode` | `src/components/coding-mode.ts` | Lazy AcpTransport lifecycle for coding agent |
| `IdleSave` | `src/components/idle-save.ts` | Timer management + chat save on idle |

### Timestamps

All user-facing timestamps use local time (not UTC). `localDate()` in `env-utils.ts` for YYYY-MM-DD, `localIso()` in `logger.ts` for full timestamps. Data storage (memory DB, recall) stays UTC.

### Logging

Source: `src/components/logger.ts`

Centralized logger with `logInfo`, `logWarn`, `logError`, `logDebug`. Console output is always human-readable. File output (`~/.agentbridge/logs/bridge.log`) supports two formats:
- `LOG_FORMAT=text` (default): `2026-03-27T17:15:56.888 INFO  [tag] message`
- `LOG_FORMAT=json`: `{"ts":"...","level":"info","tag":"...","msg":"..."}`

Credential redaction: `redactSecrets()` strips 15 secret patterns (OpenAI, GitHub, AWS, Telegram, Bearer, Stripe, etc.) from all file-logged lines. Secrets never reach `bridge.log`.

### Entry Point

- `src/main.ts` (11 lines) — entry point, calls `startBridge()`
- `src/bridge-app.ts` — `Bridge` class + `startBridge()` wiring function
  - `Bridge.initMemory()` — MemoryManager creation + initialize + logger injection via `setLogger()`
  - `Bridge.wireMemory()` — LLM callback + IPC server (after transport ready)
  - `Bridge.initTransport()` — 3-way transport selection (tmux/acp/api), TransportManager wrapping, in-process memory wiring
  - `Bridge.initDashboard()` — dashboard config, auth gate, status function, server start
  - `startBridge()` — remaining wiring: platforms, heartbeat, sleep, agent API, capabilities

## Capability System

Self-contained subsystems register via `CapabilityApi` — commands, heartbeat tasks, services. Capabilities are auto-discovered at startup from `src/capabilities/*/capability.json` manifests.

Source: `src/capabilities/capability.ts`

### Discovery

On startup, `discoverCapabilities()` scans `src/capabilities/` for directories with a `capability.json` manifest. Each is dynamically imported and its `register(api)` function called. Directories without a manifest are core capabilities (loaded explicitly).

Disable a capability: `DISABLED_CAPABILITIES=browser` (comma-separated names).

### Capabilities

| Capability | Directory | Type | What it registers |
|---|---|---|---|
| Browser | `src/capabilities/browser/` (17 files) | Discoverable | browse-checker heartbeat, lazy BrowserIpcServer, SSRF guard |
| Hotskills | `src/capabilities/hotskills/` (1 file) | Discoverable | skill-reloader heartbeat (live-reload skill .md files from core/auto/downloaded) |
| Sleep | `src/capabilities/sleep/` (12 files) | Core (no manifest) | Sleep spawn + retry, progress protocol |

### Adding a capability

1. Create `src/capabilities/<name>/capability.json`:
   ```json
   { "name": "<name>", "description": "..." }
   ```
2. Create `src/capabilities/<name>/index.ts` exporting `register(api: CapabilityApi)`
3. Restart bridge — auto-discovered, no code changes needed

### Replacing a capability

1. Drop new capability directory (e.g. `browser-v2/`)
2. Set `DISABLED_CAPABILITIES=browser`
3. Restart — old one skipped, new one loads

### Dashboard

- `src/components/dashboard-ui.ts` (311 lines) — HTML fragments with dynamic parts
- `src/public/dashboard.css` (492 lines) — static CSS
- `src/public/dashboard.js` (552 lines) — static JS
- `src/public/memory-universe.js` — standalone 3D memory visualization (Three.js, lazy-loaded)
- Build copies `src/public/` → `dist/public/` automatically
- Static files served from `dist/public/` via dashboard HTTP server

#### Memory Universe (3D visualization)

Standalone module loaded on demand via "🌌 Memory Universe" button. Full-screen Three.js scene with bloom post-processing.

| Visual | Attribute | Mapping |
|--------|-----------|---------|
| Color | classification | U=cyan, R=blue, C=amber, S=red |
| Size | recall_count | More recalled = bigger |
| Brightness | emotion_score | Positive=bright, negative=dim |
| Pulse | memory_type | fact=still, decision=slow, preference=medium, event=fast |
| Opacity | credibility | confirmed=solid, unknown=translucent |
| Core dot | trust | owner=bright white center, untrusted=none |

Entity clusters: memories sharing entities gravitate together with connecting lines. Starfield background, auto-rotate, orbit controls. Click for detail panel, hover for tooltip. Data from `/api/memory/all` endpoint.

### Startup

1. Kill orphaned `kiro-cli acp` processes from previous runs
2. Initialize transport (ACP, Direct API, or tmux)
   - ACP: spawn kiro-cli/gemini-cli with `--model` flag
   - Direct API: configure endpoint, model, tool registry, in-process memory backend
   - tmux: start tmux session
3. Wrap with TransportManager if `TRANSPORT_FALLBACK` configured (cold fallback)
4. Set system prompt for Direct API transport (SOUL bundle)
5. Initialize memory, browser, platforms
6. Create `bridge.lock` (`{pid, startedAt}`) — tracks bridge lifecycle
7. `startSession()` — inject SOUL + context + greeting (non-blocking, busyChats guard queues user messages until ready)
8. Start heartbeat (clock-synced, ≥3min guard before first tick)
9. Spawn sleep if not done today and past SLEEP_TIME (`hasSleepAuditToday()` guard, 3 retries via setTimeout)
10. Auto-restart on crash (LaunchAgent on macOS, systemd on Linux)

### Heartbeat System

Single heartbeat loop controls everything: task scheduling, standby detection, watchdog, session lifecycle.

**Clock-synced:** Ticks aligned to wall-clock boundaries (`:00`, `:05`, `:10`...) based on interval. First tick delayed ≥3min from startup for network/service stabilization.

**Standby detection:** Tracks `lastTickAt`. If gap between ticks > interval×3 (~15min), process was suspended (OS standby). Triggers the recovery flow (see Recovery section below).

**bridge.lock:** `~/.agentbridge/bridge.lock` — created on startup with `{pid, startedAt}`. Updated every tick with `lastHeartbeat` timestamp. Single source of truth for process health. Read by: `isDailyCycleDue`, `/heartbeat` command, `doctor.sh`, heartbeat watchdog timer.

**Dark wake guard:** `isDailyCycleDue` requires `lastHeartbeat` to exist in the lock file. No successful tick = system not ready (dark wake, network down). Replaces the old 5-minute uptime heuristic.

**Heartbeat watchdog timer:** Standalone `setInterval` (60s) in `bridge-app.ts`, independent of the heartbeat system. Reads `bridge.lock.lastHeartbeat` — if stale > 3× heartbeat interval (~15min), forces `process.exit(1)`. Catches dead heartbeat while process is alive. LaunchAgent restarts.

**Task registration order:**
```
tasks → idle-compact(heavy) → age-check →
db-integrity → watchdog → restart-check → self-healer →
browse-checker → skill-reloader → reminder-injector
```

---

## Transport System

Three transport implementations behind `IKiroTransport` interface:

### AcpTransport (`src/components/transport/acp-transport.ts`)
Spawns kiro-cli or gemini-cli as child process. JSON-RPC 2.0 over stdio. Real-time streaming via `agent_message_chunk` notifications. Permission auto-approve. `setModel()` kills CLI and respawns with new `--model` flag (session resets).

### DirectApiTransport (`src/components/transport/direct-api-transport.ts`)
Talks to any OpenAI-compatible `/v1/chat/completions` endpoint. Bridge owns the agent loop:

1. Build messages (system prompt + conversation history + user message)
2. POST with streaming (`stream: true`, `stream_options: { include_usage: true }`)
3. Parse SSE → emit chunks for Telegram edit-in-place
4. If `tool_calls` in response → execute via tool registry → append results → loop
5. If content only → return as final answer

**Tool registry** (`src/components/transport/tool-registry.ts`): 7 native tools — `execute_bash`, `memory_store`, `memory_recall`, `memory_edit`, `web_browse`, `todo_manage`, `task_manage`. Memory tools call in-process `MemoryBackend` when available (no CLI spawn).

**SSE parser** (`src/components/transport/sse-parser.ts`): stale stream detection (90s), Ollama-compatible tool_call tracking by ID.

**Conversation session** (`src/components/transport/conversation-session.ts`): per-session message history, token tracking, context% calculation.

Config: `API_ENDPOINT`, `API_KEY`, `API_MODEL`, `API_MAX_CONTEXT`, `API_MAX_OUTPUT`, `API_MAX_TURNS`.

### TmuxClient (`src/components/transport/tmux-client.ts`)
Legacy. Sends via `tmux send-keys`, reads via `tmux capture-pane`. Battle-tested, survives disconnects.

### TransportManager (`src/components/transport/transport-manager.ts`)
Wraps primary + fallback transport. Recovery L3: after 3 consecutive failures, cold-inits fallback transport. Heartbeat health check restores primary when it recovers. `forceRestorePrimary()` for manual override via `/transport restore`. Config: `TRANSPORT_FALLBACK=acp`.

### Fallback Chain (within Direct API)
`API_FALLBACK_1_ENDPOINT` / `API_FALLBACK_1_MODEL` (up to 5). Tried in order if primary model fails. Restores primary on next success.

### Retry
429s and transient errors retried with 3s exponential backoff (3 attempts). Status check inside retry loop.

### `/models` Command
Fetches available models from `/v1/models` (API) or `AGENT_AVAILABLE_MODELS` env (ACP). Displays as Telegram inline keyboard (1 column). Tap to hot-swap: instant for API, session reset for ACP.

### `/transport` Command
- `/transport` — shows current transport status, provider info, fallback state
- `/transport change` — lists `~/.agentbridge/transports/*.env` profiles as Telegram inline keyboard. Tap to switch: writes `AGENT_TRANSPORT_PROFILE` to `.env` → bridge restarts
- `/transport restore` — forces switch back to primary when on fallback (`TransportManager.forceRestorePrimary()`)

Command dispatcher matches exact commands by first word as fallback (after prefix commands), so `/transport change` routes correctly.

### `/status` Transport Info
Shows active transport, endpoint, model, fallback model(s), fallback transport.

## Recovery

## Recovery System

Three independent layers with no overlap. Each layer owns one responsibility.

### Architecture

```
┌─────────────────────────────────────────────────┐
│              HEARTBEAT (5 min ticks)             │
│                                                  │
│  Standby detection → classifyResume()            │
│    dark  → skip tick, kick watchdog              │
│    full  → log, run normal tick                  │
│                                                  │
│  Tasks: transport.healthCheck, age-check,        │
│         self-healer, db-integrity, ...           │
│                                                  │
│  After all tasks: write lastHeartbeat, kick WD   │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│          WATCHDOG (countdown+kick, 60s timer)    │
│                                                  │
│  Counter starts at 15min (3× heartbeat)          │
│  Every 60s: counter -= 60s                       │
│  Heartbeat kick: counter = 15min (reset)         │
│  Counter ≤ -60s (grace): exit(1)                 │
│                                                  │
│  No file I/O, no JSON, no timestamps.            │
│  Pure countdown + kick pattern.                  │
│  Morning restart after hardware sleep.           │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│          EXTERNAL (LaunchAgent + doctor.sh)       │
│                                                  │
│  Process dead → restart                          │
│  Startup → doctor.sh checks previous health      │
│  14 diagnostic checks including schema version   │
└─────────────────────────────────────────────────┘
```

### Layer 1 — Standby Resume

When heartbeat detects a skipped tick (gap > interval×3):

**Platform detection** (`platform-detect.ts` → `classifyResume()`):
- macOS: `DarkWake` → skip tick, kick watchdog (stays alive during Power Nap)
- macOS: `FullWake` → log and continue (normal tick runs)
- Linux: `journalctl` suspend check
- Unknown: falls through to normal tick

Standby resume does NOT call `isDailyCycleDue` or `process.exit`. It only classifies and logs. Age-check task owns bedtime. Watchdog owns stale process.

### Layer 2 — Watchdog (countdown+kick)

Pure countdown timer, independent of heartbeat:
- Counter starts at 15min (`hbIntervalMs × 3`)
- Every 60s: counter decrements by 60s
- Every heartbeat tick: counter resets to 15min (kick)
- Dark wakes: heartbeat fires → kicks watchdog → stays alive
- Hardware sleep (hours): no kicks → counter deeply negative → first 60s check after wake → `exit(1)`
- Grace period: kills at ≤ -60s (not ≤ 0), gives heartbeat one interval to kick after resume

No file I/O, no JSON parsing, no timestamps. Replaces the old timestamp-checking watchdog.

### Layer 3 — Bedtime Flow (age-check task)

Heartbeat task that calls `isDailyCycleDue()` every tick:

```
BED_TIME passes → quiet tick counter starts
  Any message → counter resets to 0
  Tick N-1 (T-1) → system message: agent announces sleep to user
  Tick N → Dreamy spawns directly (no bridge restart)
  Dreamy completes → check if user messaged during sleep
    Yes → skip Mac sleep, log "user active"
    No → pmset sleepnow (if MAC_SLEEP_AFTER_DREAMY=true)
  Mac wakes → watchdog fires (no kicks for hours) → exit(1)
  LaunchAgent restarts → fresh session
  If sleep missed today on startup → catch-up Dreamy spawns
```

Config: `BED_TIME` (default 2:00), `BED_QUIET_TICKS` (default 6 = 30min), `MAC_SLEEP_AFTER_DREAMY` (default false).

### Transport Health Checks

Each transport owns its own health check via `healthCheck()` on `IKiroTransport`.

| Transport | Case | Detection | Action |
|-----------|------|-----------|--------|
| ACP | Tool hung | `toolInFlight` > 3min | `sendInterrupt()` |
| ACP | Process dead | `!isConnected` | Reinit + re-send |
| ACP | Silent | No activity > 5min | Re-send prompt |
| ACP | Endless | Active > 10min | `sendInterrupt()` |
| Direct API | Silent | idle > `WATCHDOG_SILENT_SEC` | Abort request |

Config: `WATCHDOG_TOOL_TIMEOUT_SEC=180`, `WATCHDOG_SILENT_SEC=300`, `WATCHDOG_ENDLESS_SEC=600`.

### Recovery Chain

```
Transport self-heals (healthCheck)
  → Heartbeat kicks watchdog (countdown reset)
    → Watchdog catches dead heartbeat (countdown expired → exit(1))
      → LaunchAgent catches dead process (restart)
        → doctor.sh checks previous health (14 checks)
```

### Context Overflow

In the message pipeline catch block: if error matches `ValidationException` or `-32603`:
- `resetAndPrepare()` — reset session, mark for SOUL re-injection
- Tell user: "🔄 Context window full — session reset."

### Compaction Circuit Breaker

Track consecutive compaction failures per session. After 3 failures → stop trying, warn user. Reset counter on successful compaction or `/reset`.

### System Message Sender

Generic module (`system-message.ts`) for any component to send a prompt to the agent with response delivered to user. Used by bedtime T-1 warning. No-op if not initialized (tests, standalone).

### Doctor Checks (14 steps)

| # | Check | Fix mode |
|---|-------|----------|
| 1 | Required directories | Create missing |
| 2 | .env required keys | Warn |
| 3 | Node.js ≥ 22 | Warn |
| 4 | kiro-cli in PATH | Warn |
| 5 | tmux installed | Warn |
| 6 | memory.db integrity | Warn |
| 7 | memory.db size | Warn >500MB |
| 8 | FTS5 health | Rebuild |
| 9 | Orphaned tmux sessions | Kill |
| 10 | Heartbeat liveness | Warn if stale |
| 11 | Core files size | Warn >15 lines |
| 12 | Schema version ≥ 8 | Warn if pending |
| 13 | memory.env exists | Warn |
| 14 | Orphaned kiro-cli | Kill extras |

### Self-Healer

Heartbeat task that scans `bridge.log` for recent ERROR lines. Injects bug reports to the agent via Telegram so the agent is aware of issues.

### Task Failure Injection

When a cron/task job fails, error details are injected to the main agent transport:
- Agent receives: "Task X failed: [command, exit code, stderr]. Diagnose and fix if possible."
- Max 2 auto-fix attempts per entry per day (`tryInjectFailure` in `cron-queue.ts`)
- Prevents loops: same entry won't get more than 2 injections per day

### Retry Utility

Generic retry wrapper (`retry.ts` → `withRetry()`):
- Escalating backoff with jitter (300ms → 600ms → 1.2s → ... → 30s cap)
- `FATAL_PATTERNS` — known-unrecoverable errors (auth, model not found, account suspended) stop retrying immediately
- `isFatal(err)` — check if error matches fatal patterns
- `getDelayHint(err)` — extract delay from rate limit headers
- Used by: transport prompt retry, sleep step retry

### Restart Causes

Typed enum (`RestartCause` in `restart-reason.ts`):
```
daily-cycle | deploy | user-reset | watchdog-silent | watchdog-endless | ctx-overflow | manual
```
Written to `.last-restart-reason` file, injected into next session start so the agent knows why it restarted.

### Process Supervision

- **macOS:** LaunchAgent with `KeepAlive: true`, `ThrottleInterval: 60s`
- **Linux:** systemd service with `Restart=always`, `RestartSec=60`
- Template: `scripts/agentbridge@.service`

### Session Start (single path)

All session resets converge to one function: `preparePrompt()` in `message-pipeline.ts`.

**Triggers that set `pendingSessionStart`:**
- `/new`, `/reset`, `/restart` commands
- `/compact` (after compaction)
- Auto-compact (ctx% threshold)
- Auto-reset on ctx overflow (ValidationException/-32603)
- Floating compaction (idle-triggered)

**On next message, `preparePrompt()` injects:**
1. SOUL bundle (identity, tools, steering)
2. Session-start context (daily summary + recent messages)
3. Restart reason (if any)

First message to a new session also triggers injection (`!seen.has(sessionKey)`). One path, every time.

---

## Todo System

### Overview

A persistent, file-based todo list that the agent manages autonomously via a CLI tool. The agent detects "remind me" / "don't forget" patterns in conversation and stores items. The sleep cycle also extracts missed action items from daily transcripts.

### Architecture

```
User message → Agent (LLM) → detects todo intent → execute_bash: agentbridge-todo add "..."
                                                                        ↓
                                                          ~/.agentbridge/memory/todo.md
```

### CLI: `agentbridge-todo`

Source: `src/cli/agentbridge-todo.ts`
Deployed to: `~/.local/bin/agentbridge-todo` (via `scripts/deploy.sh`)

| Command | Description |
|---------|-------------|
| `agentbridge-todo add "description"` | Append `- [ ] YYYY-MM-DD: description` |
| `agentbridge-todo list` | Print all items (both open and done) |
| `agentbridge-todo done <N>` | Mark item N as `[x]` (1-based) |
| `agentbridge-todo remove <N>` | Delete item N entirely |

Output: JSON on stdout (`{ "ok": true, "action": "added", ... }` or `{ "ok": false, "error": "..." }`).

### File Format

Path: `~/.agentbridge/memory/todo.md`

```markdown
# Todo List

- [ ] 2026-03-15: Export X/Twitter session cookies
- [ ] 2026-03-15: Investigate daily report not functioning
- [x] 2026-03-14: Fix browser socket permissions
```

- Created automatically on first use
- Items are markdown checkboxes with date prefix
- Item numbers for `done`/`remove` are 1-based, counting only `- [ ]` and `- [x]` lines

### Skill Steering

File: `skills/todo/SKILL.md` → deployed to `~/.agentbridge/.kiro/steering/todo.md`

Triggers: "remind me", "don't forget", "add to my list", "todo", "emlékeztess", "ne felejtsd", "what's on my list"

Does NOT trigger for: time-specific reminders (→ cron), facts/preferences (→ instant-store)

### Tests

File: `src/cli/agentbridge-todo.test.ts` — 7 tests covering add, list, done, remove, error cases.

---

## Cron System

### Overview

A time-based scheduling system for reminders and tasks. The agent creates cron entries when users mention specific dates/times. The `HeartbeatSystem` (see above) is the single owner of cron scanning. Due reminders are injected into conversation; due tasks are processed by `CronQueue`. Heavy tasks (agent cron jobs) are blocked while sleep is active (`sleepActive` callback) to avoid model rate-limit contention.

### Architecture

```
User: "remind me tomorrow at 8am"
  → Agent → execute_bash: agentbridge-cron add --at "2026-03-16T08:00" --message "..." --chat-id 123 --type reminder
                                                        ↓
                                          ~/.agentbridge/memory/memory.db (cron_entries table)

Every 5 min (HeartbeatSystem — cron task):
  → checkCron() reads cron_entries from SQLite, returns due entries
  → Due reminders → pending_reminders.json → injected as synthetic message
  → Due tasks → cronQueue.enqueue(entry) → sequential processing
```

### Cron Storage — SQLite

Source: `src/components/cron-db.ts`

Cron entries are stored in the `cron_entries` table in `memory.db` (same database as the memory system). Replaces the old `cron.json` file — eliminates race conditions from concurrent read-modify-write by multiple processes.

**Migration:** On first use, `cron-db.ts` auto-imports `cron.json` → SQLite and renames the file to `cron.json.migrated`.

**Functions:** `readEntries()`, `readEntry(id)`, `writeEntry(e)`, `removeEntry(id)`, `recordRun(id, exitCode)`, `closeDb()`.

### CronQueue — Sequential Job Processor

Source: `src/components/cron-queue.ts`

Replaces inline task spawning. All task execution goes through the queue.

**Behavior:**
- Scripts and agents run sequentially — never concurrent
- Priority-sorted: high jobs jump ahead of pending medium/low
- Duplicate prevention: same entry ID can't be queued or running twice
- 30-min hard timeout on agent tasks (SIGKILL)
- Retry once on failure: sets `fireAt = now + 10min` + `_retrying = true`. If retry also fails, waits for next scheduled time
- Exit codes persisted to SQLite history via `cron-db.recordRun()`

**Agent task flow (via AcpTransport):**
1. Create fresh `AcpTransport` instance (same pattern as CodingMode)
2. `transport.initialize()` → spawns `kiro-cli acp --agent professor`
3. `transport.sendPrompt(sessionKey, prompt)` — handles session creation + prompt
4. `transport.destroy()` — kills the process
5. Write result to `~/.agentbridge/workspace/cron-results/{entryId}_{date}.md`
6. Run DoD checks if task has `taskFile`
7. Record exit code to history
8. Report to Telegram: ✅ on success (exit 0), ❌ on failure/DoD fail

**Script task flow:**
1. `spawn("bash", ["-c", entry.message])`
2. Capture stdout+stderr
3. Record exit code to history

### Task Descriptions (`tasks/` folder)

Agent cron tasks reference a `.md` file instead of embedding instructions inline in `cron.json`.

| File | Cron ID | Schedule |
|------|---------|----------|
| `tasks/daily-ai-report.md` | `02565e` | `0 10 * * *` |
| `tasks/weekly-ai-report.md` | `1672b4` | `15 12 * * 0` |
| `tasks/finance-daily.md` | `7517d6` | `0 13 * * 1-5` |

**CronEntry fields:**
- `taskFile?: string` — path to `.md` file (relative to WORKING_DIR)
- `message: string` — short label for display (e.g. "Daily AI report")

**Task file format:**
```markdown
# Task Title

Instructions for the agent...
Uses {today} placeholder → substituted with YYYY-MM-DD local date at runtime.

## Definition of Done
- ~/.agentbridge/reports/AI-Daily-{today}.md
```

**DoD checks** (after agent exits):
- Each line under `## Definition of Done` is a file path
- `{today}` substituted with local date
- Check: file exists + size > 100 bytes
- Pass → exitCode 0, Fail → exitCode 1 + retry

Deploy: `scripts/deploy.sh` copies `tasks/*.md` to `~/.agentbridge/tasks/`.

### `/tasks` Display (alias: `/cron`)

Source: `src/components/command-handlers.ts`

Status icons per task:
- `✓` — succeeded (exitCode 0 in today's history)
- `~` — currently running (checked via `cronCurrentJob`)
- `✗` — failed or orphaned (started today, no success, not running)
- `+` — pending, hasn't run yet today
- `—` — not scheduled today (day-of-week mismatch)

Sorted chronologically by schedule time. Shows running job PID + duration.

### CLI: `agentbridge-cron`

Source: `src/cli/agentbridge-cron.ts`
Deployed to: `~/.local/bin/agentbridge-cron` (via `scripts/deploy.sh`)

| Command | Description |
|---------|-------------|
| `agentbridge-cron add --at <ISO> --message <text> --chat-id <ID> [--type reminder\|task] [--executor agent\|script]` | One-shot entry |
| `agentbridge-cron add --schedule "<cron expr>" --message <text> --chat-id <ID> [--type task] [--executor script]` | Recurring entry |
| `agentbridge-cron list` | Show active entries (with lastRanAt, schedule, executor) |
| `agentbridge-cron remove <id>` | Delete entry by 6-char hex ID |
| `agentbridge-cron pause <id>` | Temporarily disable entry |
| `agentbridge-cron resume <id>` | Re-enable paused entry |
| `agentbridge-cron history <id>` | Show last 10 runs with timestamps and exit codes |

Output: JSON on stdout.

### Data Format

Stored in `cron_entries` table in `~/.agentbridge/memory/memory.db` (SQLite).

Columns: `id`, `fire_at`, `message`, `chat_id`, `type`, `executor`, `schedule`, `priority`, `task_file`, `paused`, `fired`, `created_at`, `last_ran_at`, `retry_after`, `retrying`, `history` (JSON array).

- `fire_at`: epoch milliseconds (auto-computed from `schedule` for recurring entries)
- `executor`: `"agent"` (default — processed by CronQueue via AcpTransport) or `"script"` (runs `bash -c` directly)
- `schedule`: optional cron expression (e.g. `"30 7 * * *"`). When present, entry reschedules after firing.
- `task_file`: optional path to task description `.md` file (agent tasks only).
- `history`: JSON array, last 10 runs as `[{ ts, exitCode? }]`. Exit codes recorded by CronQueue.
- `retrying`: internal flag for one-time retry tracking.
- Fired one-shot entries (no `schedule`) are GC'd after 7 days.

### Cron Checker

Source: `src/components/cron-checker.ts`
Wired in: `src/bridge-app.ts` — registered as `cron` task in the unified `HeartbeatSystem` (5-min interval)

`checkCron()` is a pure scanner: reads `cron_entries` from SQLite, fires reminders, returns due task entries. No spawning — that's CronQueue's job.

**Reminder flow:**
1. `checkCron()` finds entries where `fireAt <= now` and `fired === false`
2. Reminders → writes to `~/.agentbridge/memory/pending_reminders.json`
3. Marks entry as `fired: true` (one-shot) or reschedules next `fireAt` (recurring)
4. `reminder-injector` heartbeat task reads `pending_reminders.json`, injects each as synthetic message
5. Clears `pending_reminders.json`

**Task flow:**
1. Same trigger as reminders
2. Returns due task entries to caller
3. Caller (`main.ts` heartbeat) enqueues them into `CronQueue`

**Recurring entries:** When a `CronEntry` has a `schedule` field (cron expression), after firing it computes the next `fireAt` and stays active. One-shot entries (no `schedule`) are marked `fired: true` permanently.

### Pending Reminders File

Path: `~/.agentbridge/memory/pending_reminders.json`

```json
[
  { "chatId": 7773842843, "message": "Export session cookies", "createdAt": 1773580800000 }
]
```

Acts as file-based IPC between the cron checker and the message injection loop. Also writable by the sleep agent for reminders extracted from transcripts.

### Skill Steering

File: `skills/cron.md` → deployed to `~/.agentbridge/.kiro/steering/cron.md`

Triggers: "remind me at 3pm", "Sunday at 2am do X", "every day at 8am run...", specific time references

Does NOT trigger for: vague "remind me later" without time (→ todo), immediate actions

All scheduling goes through `agentbridge-cron` CLI — never host crontab.

### Shutdown

`cronInterval` is cleared in the `shutdown()` handler in `main.ts`.

### Tests

- `src/cli/agentbridge-cron.test.ts` — 7 tests: add, list, remove, error cases, default type
- `src/components/cron-checker.test.ts` — 14 tests: reminders, tasks, recurring, GC, empty DB
- `src/components/cron-queue.test.ts` — tests: enqueue, dedup, priority sort, script execution
- `src/components/command-handlers.test.ts` — 12 tests: /new, /coding, /trigger, /status, /help, etc.

---

## Context Window Management

Tracks and manages the LLM context window with graduated thresholds and own compaction system (transport-agnostic).

### Monitoring

- `contextPercent` tracked on every ACP response via `_kiro.dev/metadata` notification
- tmux: parsed from kiro-cli output
- Logged on every inbound (`ctx: XX%`) and outbound
- Dashboard shows live ctx% via WebSocket
- `/status` command displays current ctx%
- Gemini CLI: self-manages at 50% internally, bridge is blind to ctx%

### Graduated Thresholds

Config: `CTX_WARN_PCT` (default 70), `CTX_COMPACT_PCT` (default 80), `CTX_AGGRESSIVE_PCT` (default 90). Only fire when `contextPercent >= 0` (kiro transport).

| Level | ctx% | Action |
|-------|------|--------|
| Normal | <70% | Nothing |
| Warning | ≥70% | Log + notify user once per session |
| Compact | ≥80% | Trigger compaction (see below) |
| Aggressive | ≥90% | Compact + strip media from injection |
| Overflow | error | Auto-reset session (`ValidationException` / `-32603`) |

Per-session tracking: `ctxWarned` set (no spam), `compactFailures` map (circuit breaker).

### Compaction System

Own compaction — no dependency on kiro's `/compact`. Works with any transport.

**Flow:**
1. Send compaction prompt to the **same session** (model has conversation in context, 20% headroom)
2. Model produces `<analysis>` (scratchpad, stripped) + `<summary>` (8-section structured summary)
3. `resetSession(sessionKey)` — wipes the CLI's context
4. Inject as first message: compaction summary + memory context block
5. Mark `pendingSessionStart` — next user message gets full session-start context
6. User continues naturally

**Compaction prompt** (`compaction.ts`): adapted from Claude Code. Sections: user intent, decisions, technical context, errors/fixes, user messages, pending tasks, current work, next step. `NO_TOOLS` preamble forces text-only response.

**Memory context block** (`session-memory.ts`): appended after LLM summary:
- Last 5 extracted memories by recency (simple DB query)
- Today's daily summary (if exists)
- Active todo items

**User `/compact`**: intercepted by bridge, runs full compaction. `//compact` passes through to kiro's native compact.

### Auto-Reset on Overflow

If the model returns `ValidationException` or error code `-32603` (context too large):
1. Resets the ACP session immediately
2. Marks session for fresh session-start injection
3. Notifies user: "🔄 Context window full — session reset."

### Key Files

| File | Purpose |
|------|---------|
| `src/components/compaction.ts` | Compaction prompt + summary extraction |
| `src/memory/session-memory.ts` | Memory context block builder |
| `src/components/message-pipeline.ts` | Graduated thresholds, auto-compact trigger, circuit breaker |
| `src/components/command-handlers.ts` | `/compact` command handler |
| `src/components/ssrf-guard.ts` | SSRF protection — private IP blocking + DNS rebinding check |
| `src/components/path-guard.ts` | Path traversal prevention — `isWithinRoot()` |

---

## Self-Healing Agent

Heartbeat task (`self-healer`) that scans `bridge.log` for ERROR lines every 5 minutes. When errors are found, injects `[SYSTEM BUG REPORT]` messages to KP via the Telegram pipeline. KP can analyze, attempt fixes, or notify the user.

- Dedup: same error key (tag + message) not reported again for 30 minutes
- Rate limit: max 3 reports per tick
- Gated by `SELFHEAL_ENABLED` (default: true)
- Config: `SELFHEAL_MAX_REPORTS` (default 3), `SELFHEAL_COOLDOWN_MIN` (default 30)

---

## Browser Agent (Browsie)

### Overview

A smart, autonomous browser subagent that runs as a detached process. The professor delegates browser tasks to Browsie instead of running browser commands directly, preventing long-running or hanging browser operations from blocking the bridge.

Browsie gets a high-level goal (e.g., "check X notifications", "post on FB", "fill out a web form"), autonomously drives a headless Chromium browser inside a Docker container, and returns a summary when done. Same subagent pattern as the Sleep Agent.

### Problem Solved

When the professor ran browser commands directly via `execute_bash`, the entire bridge froze — no messages processed, no heartbeat, nothing. The X/Twitter cookie injection hung for 12+ minutes and blocked KP completely. Browsie eliminates this by running in a separate detached process.

### Architecture

```
User: "check my X notifications"
  → Professor → execute_bash: agentbridge-browse --task "check X notifications" --chat-id 123
  → CLI returns immediately: { "ok": true, "taskId": "a1b2c3", "status": "spawned" }
  → Professor tells user: "On it, I'll report back shortly"
  → Professor is FREE for new messages

Background (detached):
  → kiro-cli acp --agent professor
  → reads browsing_prompt.md (task goal + browser tool instructions)
  → autonomously: navigate → extract → screenshot → reason → adapt
  → writes output to ~/.agentbridge/logs/browse_<taskId>.log
  → process exits

Every 5 min (main.ts HeartbeatSystem — browse-checker task):
  → checkBrowseTasks() reads pending_browse.json
  → pid dead? → read log tail → deliver result via pending_reminders.json → inject into chat
  → pid alive past timeout? → kill, report timeout
  → pid alive within timeout? → skip
```

### CLI: `agentbridge-browse`

Source: `src/cli/agentbridge-browse.ts`
Deployed to: `~/.local/bin/agentbridge-browse` (via `scripts/deploy.sh`)

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `--task` | yes | — | High-level goal description |
| `--chat-id` | yes | — | Chat ID for result delivery |
| `--timeout` | no | 300 (5min) | Timeout in seconds |
| `--dry-run` | no | — | Print prompt to stdout, don't spawn |

Output: `{ "ok": true, "taskId": "a1b2c3", "status": "spawned", "pid": 12345 }`

Internally:
1. Loads `browsing_prompt.md` template, replaces `${TASK}`, `${TASK_ID}`, `${REPORT_FILE}`
2. Reads `BROWSING_AGENT` from env (default `claude-sonnet-4.5`), spawns detached wrapper that runs `kiro-cli acp --agent professor --model <BROWSING_AGENT>`
3. Wrapper handles full ACP lifecycle: initialize (60s timeout) → session/new (60s) → session/prompt (10min)
4. Logs subprocess output to `~/.agentbridge/logs/browse_<taskId>.log`
5. Writes task metadata to `~/.agentbridge/memory/pending_browse.json`
6. Prints JSON result and exits immediately

### Prompt Template

File: `persona/browsing_prompt.md` → deployed to `~/.agentbridge/browsing_prompt.md`

Sections:
- Task goal (from `--task`)
- Full browser tool reference (`agentbridge-browser` actions: navigate, click, fill, extract_text, screenshot, get_page_info, set_cookie, close_session)
- Docker container management (`~/.agentbridge/browser-patchright.sh start`)
- Login state: navigate first, use `set_cookie` with container-internal cookie files (`/run/browser/cookies/`) if not logged in
- Output: write findings to `~/.agentbridge/subagents/browse_<taskId>_<date>.md`

### Task Lifecycle

File: `~/.agentbridge/memory/pending_browse.json`

```json
[
  {
    "taskId": "a1b2c3",
    "task": "check X notifications",
    "chatId": 7773842843,
    "pid": 12345,
    "startedAt": 1773580800000,
    "timeoutMs": 300000,
    "logFile": "~/.agentbridge/logs/browse_a1b2c3.log"
  }
]
```

Checked by `checkBrowseTasks()` in `src/components/cron-checker.ts`, registered as `browse-checker` task in the unified `HeartbeatSystem` in `main.ts`. Also runs once on startup.

### Delegation Steering

File: `skills/browse-delegate/SKILL.md` → deployed to `~/.agentbridge/.kiro/steering/browse-delegate.md`

Rules for the professor:
- NEVER run `agentbridge-browser` commands directly
- NEVER run `docker exec` on the browser container
- NEVER write inline scripts that interact with the browser
- ALWAYS use `agentbridge-browse --task "..." --chat-id <ID>`

### Browser Docker Architecture

Container: `agentbridge-browser` — headless Chromium controlled via `agentbridge-browser` CLI over Unix socket IPC.

Management script: `scripts/browser-patchright.sh` → deployed to `~/.agentbridge/browser-patchright.sh`

| Command | Description |
|---------|-------------|
| `browser-patchright.sh build` | Build image + start container |
| `browser-patchright.sh start` | Start container (existing image) |
| `browser-patchright.sh stop` | Stop + remove container |
| `browser-patchright.sh status` | Check if running |

Docker mounts (isolated):
```
~/.agentbridge/browser-socket/ → /run/browser       (rw, IPC socket)
~/.agentbridge/titok/cookies/  → /run/browser/cookies (ro, cookie files only)
```

The `set_cookie` action loads JSON cookie files into the browser context. Cookie files must be under `/run/browser/cookies/` (enforced by path validation in `browser-tool.ts`). Cookie file format: `{ "cookie_name": "cookie_value", ... }`.

Socket path: `~/.agentbridge/browser-socket/browser.sock`

### Troubleshooting

Diagnostic commands are in `skills/troubleshooting/SKILL.md` (Browser Agent section):
- `docker ps --filter name=agentbridge-browser` — container status
- `agentbridge-browser --action screenshot` — see current browser state
- `agentbridge-browser --action extract_text` — read page content
- `cat ~/.agentbridge/memory/pending_browse.json` — pending tasks
- `ls ~/.agentbridge/logs/browse_*.log` — task logs
- `agentbridge-browser --action close_session` — kill stuck session

### Tests

- `src/cli/agentbridge-browse.test.ts` — 8 tests: arg parsing, validation, template loading, variable replacement
- `src/components/browse-checker.test.ts` — 5 tests: dead pid delivery, timeout kill, alive skip, missing file, graceful fallback

---

## Direct API Transport & Model Fallback

### Transport Profiles
Transport profiles in `~/.agentbridge/transports/<name>.env` configure endpoint, model, and API key per provider. Active profile set by `AGENT_TRANSPORT_PROFILE` in `.env`.

| Profile | Transport | Primary Model | Endpoint |
|---------|-----------|--------------|----------|
| `kiro` | ACP | minimax-m2.5 | kiro-cli |
| `gemini` | ACP | gemini-2.5-flash | gemini-cli |
| `api` | API | kimi-k2.5:cloud | Ollama + OpenRouter fallback |
| `openrouter` | API | qwen3.6-plus:free | OpenRouter |
| `ollama` | API | kimi-k2.5:cloud | Ollama |

### Leaky Bucket Model Routing
Each model has an in-memory error bucket (0–100%). Errors fill the bucket, time drains it.

| Error | Fill | Drain |
|-------|------|-------|
| 429 (rate limit) | +40% | 3%/min |
| 401/402/403 (auth) | +100% | 3%/min |
| 500/timeout (transient) | +15% | 3%/min |

**Threshold:** model skipped when bucket > 70%. Drain is lazy — calculated on access, no timers.

### Fallback Flow
```
Prompt arrives:
  1. User override model? → try it first
  2. For each candidate (primary → fallback_1 → fallback_2 → ...):
     → bucket > 70%? skip
     → context too large for model? skip
     → try model
     → success: return
     → 429: fill bucket, rollback to last user message, try next
     → other error: fill bucket, rollback, try next
  3. All API models exhausted:
     → compact session to fit smallest model, retry
  4. Still fails → TRANSPORT_FALLBACK=acp (kiro)
```

### Context-Aware Fallback
Each fallback model has `API_FALLBACK_N_MAX_CONTEXT`. If `lastPromptTokens > maxContext * 0.95`, model is skipped. Emergency compaction (`truncateToFit`) drops oldest messages as last resort before transport switch.

### User Model Switch
`/model` command switches via `setModel()`. Override persists across prompts — bucket loop tries user's choice first. Override added as candidate even if not in configured fallback list.

### Notifications
- `⚡ Fallback: <model> (ctx: ~X%)` sent to Telegram before fallback response
- Self-healer ignores all `API error` log lines (bucket handles them)

### Commands
| Command | Description |
|---------|-------------|
| `/transport` | Active model, bucket health per model (🟢🟡🔴), provider info |
| `/transport change` | Switch transport profile (inline keyboard) |
| `/transport restore` | Force back to primary |
| `/model` | List + switch models (from active endpoint + fallbacks) |
| `/status` | Shows active model, build hash+date |

## Deploy Wiring

All persona files and CLIs deployed via `scripts/deploy.sh` (supports `--quick` to skip build).

**Persona directories** (source: `persona/` in repo):

| Source | Deploy target | Override logic |
|--------|--------------|----------------|
| `persona/core/` (gitignored) | `~/.agentbridge/core/` | Personal files; falls back to `persona/core_templates/` for fresh installs |
| `persona/prompts/` | `~/.agentbridge/prompts/` | Always from repo |
| `persona/skills/` | `~/.agentbridge/skills/core/` | Always from repo |
| `persona/agents/` | `~/.agentbridge/agents/` | Sub-agent rules (e.g. CODING.md) |
| `persona/tasks/` (gitignored) | `~/.agentbridge/tasks/` | Personal; creates empty dir if missing |
| `persona/core/.env` (gitignored) | `~/.agentbridge/.env` | Falls back to existing, then `.env.example` |

All copies use `safe_cp` — never overwrites a newer file in production.

**Soul injection**: Bridge reads `~/.agentbridge/core/*.md` (SOUL.md, TOOLS.md, user_profile.md, agent_notes.md) and injects as the first message at session start. No `.kiro/steering/` dependency — works with any CLI backend.

**CLI wrappers** (bash scripts in `~/.agentbridge/`, symlinked to `~/.local/bin/`):
All `agentbridge-*` CLIs: recall, store, edit, sleep, browse, todo, cron, tweet, rss, expand, embed.

---

## Backup

**Script:** `scripts/daily-backup.sh` — runs as a daily cron task.

### Zip backup (local)
```
~/.backup-agentbridge/agentbridge-YYYYMMDD.zip
```
Contains: `memory/`, `core/`, `skills/` (core/auto/downloaded), `agents/`, `prompts/`, `tasks/`, `topics/`, `reports/`, `finance/`.
Excludes: WAL/SHM files, pending state. Retention: 7 days (older auto-deleted).

### Git backup (remote)
Repository: `kiroprof-backup` on GitHub. Tracks text content only:
- `core/` — SOUL.md, TOOLS.md, user_profile.md, agent_notes.md
- `memory/daily|weekly|quarterly|retrospectives|audit` — summaries and reports
- `skills/` (core/auto/downloaded), `agents/`, `prompts/`, `tasks/` — agent behavior
- `finance/`, `reports/`, `twitterX/` — output data
- `backup/memory.db.enc` — AES-256-CBC encrypted SQLite database

**Encrypted DB**: `memory.db` is encrypted with `openssl aes-256-cbc -pbkdf2` using key at `~/.agentbridge/titok/db.key`, written to `backup/memory.db.enc`, and pushed to git. No smudge/clean filters — plain encrypted blob.

**Restore:**
```bash
openssl enc -d -aes-256-cbc -pbkdf2 -pass file:titok/db.key \
  -in backup/memory.db.enc -out memory/memory.db
```

**Gitignored from backup repo:** `.env`, CLI wrappers, `memory.db` (raw), WAL/SHM, logs, RSS dumps, transient state.

---

## Status & Healthcheck

Two layers of diagnostics:

### `/status` (dumb, hardcoded)

Intercepted in `command-handlers.ts` before the message reaches the agent. Works even if the agent/transport is broken. Shows: version, model, context window %, uptime, transport status, heartbeat state, last tick age, registered tasks, last sleep audit, cron summary, last backup, MCP server status.

### Chat Commands

All commands handled by `src/components/command-handlers.ts` — single module for both Telegram and Discord. Platform-specific commands check `ctx.platform` internally.

| Command | Platforms | Description |
|---------|----------|-------------|
| /new | both | New conversation session |
| /reset | both | New session + exit coding mode back to KP |
| /status | both | Bot status, transport, heartbeat, MCP |
| /stop, /cancel | both | Send Ctrl+C interrupt |
| /restart | both | Restart Kiro (tmux only) |
| /memory | both | Memory storage statistics |
| /tasks (alias: /cron) | both | Scheduled tasks overview with status icons |
| /tasks log \<id\> (alias: /cron log) | both | Last 5 runs with exit codes for a task |
| /tasks trigger \<id\> (alias: /cron trigger) | both | Manually fire a cron task immediately |
| /facts | both | Core knowledge (user profile + agent notes) |
| /coding | both | Switch to Opus coding agent |
| /default | both | Switch back to KP |
| /nlm | both | Knowledge base operations |
| /full, /short | TG-only | Raw output / clean responses toggle |
| /a2a-reset | Discord-only | Reset A2A session |
| /help | both | Auto-generated per platform |


### Healthcheck skill (agent-driven)

`skills/healthcheck.md` — 10-step self-diagnostics guide. Triggered when user asks KP to "do a healthcheck." Goes through the agent, runs bash commands (doctor.sh, sqlite3 queries, log grep, file checks), reports ✅/⚠️/❌ summary.

---

## Sleep Garbage Collection (Dreamy)

See [memory.asbuilt.md](memory.asbuilt.md) — "Sleep Cycle — Dreamy" section.

### Auto-Skill Creation (Sleep Step 15)

Dreamy reviews the day's conversations for skill-worthy patterns during sleep cycle:
- Trial-and-error approaches, user corrections, multi-step workflows
- Uses `agentbridge-skill` CLI to create/edit/patch skills in `~/.agentbridge/skills/auto/`
- Security scan (`prompt-scanner.ts`) on every write — blocks injection attempts
- SkillWatcher picks up new/changed files on next heartbeat tick

**Skill types:**
| Type | Directory | Source |
|---|---|---|
| Core | `~/.agentbridge/skills/core/` | Deployed from repo |
| Auto-created | `~/.agentbridge/skills/auto/` | Agent creates during sleep |
| Downloaded | `~/.agentbridge/skills/downloaded/` | ClawHub sync (future) |

---

## Doctor (`scripts/doctor.sh`)

Two-stage health check inspired by OpenClaw's `openclaw doctor` / `openclaw doctor --repair` pattern.

### Usage

```bash
doctor.sh              # diagnose only — prints warnings, changes nothing (runs on startup)
doctor.sh --fix        # safe fixes (chmod, mkdir, stale locks, stale sleep locks)
doctor.sh --fix-full   # all safe fixes + FTS rebuild, WAL checkpoint, git push check
```

### Diagnose (default, safe for startup)

| # | Check | Warns when |
|---|-------|------------|
| 1 | Directory permissions | Sensitive dirs (`titok/`, `cookies/`, `memory/`) not 700 |
| 2 | Stale locks | `.lock` files older than 1 hour (excludes sleep locks) |
| 3 | Stale sleep locks | `sleep_*.lock` older than 2h with no matching audit `.md` — detects hung sleep |
| 4 | Stale browse artifacts | `browse_*` files in `logs/` older than 3 days |
| 5 | Cookie validity | `x-cookies.json` missing or invalid JSON |
| 6 | Required dirs | Any of `twitterX/`, `skills/`, `logs/`, `memory/sleep/`, `memory/retrospectives/` missing |
| 7 | Follows file | `base.follows.json` missing |
| 8 | Recent backup | No `agentbridge-*.zip` in `~/.backup-agentbridge/` within 2 days |
| 9 | DB integrity | `PRAGMA integrity_check` fails |
| 10 | DB size | `memory.db` exceeds 400MB (80% of 500MB budget) |
| 11 | Sleep recency | No `sleep_*.md` audit in last 3 days |

### Fix (`--fix`)

All diagnose checks above, plus applies safe repairs:
- chmod 700 on sensitive dirs
- Remove stale locks and browse artifacts
- Remove stale sleep locks (unblocks hung sleep retries)
- Create missing dirs

### Fix Full (`--fix-full`)

Everything in `--fix`, plus:
- FTS5 rebuild (`messages_fts` + `extracted_memories_fts`)
- WAL checkpoint (truncate)
- Git push dry-run (5s timeout) — verifies backup push will work

### Integration

- `agentbridge.sh` runs `doctor.sh` (diagnose only) before starting the bridge
- Internal cron runs `doctor.sh --fix` every 6 hours (safe auto-repair)
- No `-e` flag — individual check failures don't block startup

---

## Google Workspace CLI (`gws`)

### Overview

KP reads Gmail (and potentially Drive, Calendar, Sheets) via the official `gws` CLI. No wrapper — agent calls `gws gmail` commands directly via `execute_bash`.

### Installation

```bash
npm install -g @googleworkspace/cli
gws --version  # verify
```

### Authentication (one-time)

1. Google Cloud Console → create project (or reuse existing)
2. Enable Gmail API in [API Library](https://console.cloud.google.com/apis/library)
3. OAuth consent screen → External → add your email as test user
4. Credentials → Create OAuth client ID → **Desktop app**
5. Download `client_secret.json` (or copy client ID + secret)

```bash
# Option A: place the JSON file
mkdir -p ~/.config/gws
cp client_secret_XXX.json ~/.config/gws/client_secret.json
chmod 600 ~/.config/gws/client_secret.json
gws auth login

# Option B: env vars (no file needed)
export GOOGLE_WORKSPACE_CLI_CLIENT_ID="<client-id>"
export GOOGLE_WORKSPACE_CLI_CLIENT_SECRET="<client-secret>"
gws auth login
```

Browser opens for consent. Credentials saved encrypted to `~/.config/gws/credentials.enc`. After login, env vars are no longer needed.

### Verify

```bash
gws auth status
gws gmail users messages list --params '{"userId": "me", "q": "is:unread", "maxResults": 3}'
```

### Cron Entry

Integrated into AI news pipeline (cron `02565e`, 10:00 daily). Agent searches Gmail for AI-related emails from last 24h, reads content, marks as read, aggregates into `~/reports/AI-Daily-TODAY.md`.

### Key Commands

```bash
# List messages
gws gmail users messages list --params '{"userId": "me", "q": "is:unread", "maxResults": 30}'

# Read metadata only
gws gmail users messages get --params '{"userId": "me", "id": "MSG_ID", "format": "metadata", "metadataHeaders": ["From","Subject","Date"]}'

# Read full message
gws gmail users messages get --params '{"userId": "me", "id": "MSG_ID"}'
```

### Files

- `~/.config/gws/client_secret.json` — OAuth client config (chmod 600)
- `~/.config/gws/credentials.enc` — encrypted refresh token
- `~/.config/gws/token_cache.json` — access token cache (auto-refreshed)
