# Kiro Professor — As-Built Documentation

> **Update rules:** This document reflects the CURRENT state of the system. When updating:
> - Never add historical notes ("was X", "changed from Y", "removed Z")
> - Never use strikethrough for deleted components — just remove the row
> - Never annotate with NEW/REMOVED/Unchanged — every line describes what exists NOW
> - If a component is deleted, delete its documentation entirely
> - Refactor history belongs in git commits and backlog, not here

## Overview

Kiro Professor is a standalone Node.js agent that bridges Telegram (and Discord) to [Kiro CLI](https://kiro.dev). It polls messaging platforms, forwards user messages to a kiro-cli session, and returns responses. Supports tmux and ACP (Agent Client Protocol) transports, an optional localhost web dashboard, a local memory system, a sleep maintenance cycle, and agent-callable CLI tools for memory storage, recall, browser automation, todo management, and scheduled reminders.

For the memory subsystem, see [memory.asbuilt.md](memory.asbuilt.md).

---

## Subsystems

| Subsystem | Description |
|-----------|-------------|
| **Platform Abstraction** | Telegram + Discord adapters behind a shared `PlatformAdapter` interface and unified message pipeline. |
| **Memory** | SQLite-backed persistence with FTS5, vector embeddings, CIA-AAA security model, Darwinism, emotion scoring. See [memory.asbuilt.md](memory.asbuilt.md). |
| **Sleep (Dreamy)** | Overnight maintenance: retrospective, GC, extraction, consolidation, fitness review. See [memory.asbuilt.md](memory.asbuilt.md). |
| **Cron** | Time-based scheduling for reminders and agent tasks. SQLite storage, sequential CronQueue, priority levels, retry. |
| **Todo** | File-based todo list (`todo.md`). Agent-managed via `agentbridge-todo` CLI. |
| **Browser (Browsie)** | Detached browser subagent. Headless Chromium in Docker, autonomous navigation, non-blocking. |
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
| `TelegramAdapter` | `src/platforms/telegram-adapter.ts` | voice, reactions, groups, typing, TTS |
| `DiscordAdapter` | `src/platforms/discord-adapter.ts` | reactions (emoji scoring), A2A, mention stripping |

### Message Pipeline (`src/components/message-pipeline.ts`)

`handleInboundMessage()` — shared flow for all platforms. Dependencies injected via `PipelineDeps`.

### Extracted Components

| Component | Source | Purpose |
|-----------|--------|---------|
| `SleepQueue` | `src/components/sleep-queue.ts` | Unused — main transport available during sleep |
| `CodingMode` | `src/components/coding-mode.ts` | Lazy AcpTransport lifecycle for coding agent |
| `IdleSave` | `src/components/idle-save.ts` | Timer management + chat save on idle |

### Timestamps

All user-facing timestamps use local time (not UTC). `localDate()` in `env-utils.ts` for YYYY-MM-DD, `localIso()` in `logger.ts` for full timestamps. Data storage (memory DB, recall) stays UTC.

### Logging

Source: `src/components/logger.ts`

Centralized logger with `logInfo`, `logWarn`, `logError`, `logDebug`. Console output is always human-readable. File output (`~/.agentbridge/logs/bridge.log`) supports two formats:
- `LOG_FORMAT=text` (default): `2026-03-27T17:15:56.888 INFO  [tag] message`
- `LOG_FORMAT=json`: `{"ts":"...","level":"info","tag":"...","msg":"..."}`

### Entry Point

- `src/main.ts` (11 lines) — entry point, calls `startBridge()`
- `src/bridge-app.ts` (622 lines) — all wiring: config, transport, adapters, heartbeat, dashboard, shutdown

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
2. Initialize transport (ACP or tmux)
3. Initialize memory, browser, platforms
4. Read `bridge.lock` — if `exitReason === "standby"` and recent (< 30min) → 3-min grace period (if OS sleeps during grace, process dies quietly)
5. Create `bridge.lock` (`{pid, startedAt}`) — tracks bridge lifecycle
5. `startSession()` — inject SOUL + context + greeting → agent comes online
6. Start heartbeat (clock-synced, ≥3min guard before first tick)
7. Spawn sleep if not done today (`hasSleepAuditToday()` guard, 3 retries via setTimeout)
8. Auto-restart on crash (LaunchAgent KeepAlive)

### Heartbeat System

Single heartbeat loop controls everything: task scheduling, standby detection, watchdog, session lifecycle.

**Clock-synced:** Ticks aligned to wall-clock boundaries (`:00`, `:05`, `:10`...) based on interval. First tick delayed ≥3min from startup for network/service stabilization.

**Standby detection:** Tracks `lastTickAt`. If gap between ticks > interval×3 (~15min), process was suspended (Mac standby or HB bug). Triggers: `doctor --fix` → write `exitReason: "standby"` to `bridge.lock` → `process.exit(0)` → LaunchAgent restarts.

**Standby grace period:** On startup, if `bridge.lock` has `exitReason === "standby"` and `exitedAt` < 30min ago → wait 3 minutes before starting. Prevents wasted restarts during brief Power Nap wakes. If OS sleeps during grace → process dies quietly.

**24h fallback:** `age-check` task — if `bridge.lock.startedAt` >24h AND idle >1h → same doctor + restart sequence. Covers always-on (no standby).

**bridge.lock:** `~/.agentbridge/bridge.lock` — created on startup with `{pid, startedAt}`. On standby exit: `{pid, startedAt, exitReason: "standby", exitedAt}`. LaunchAgent ThrottleInterval: 60s.

**Task registration order:**
```
cron → idle-compact(heavy) → age-check →
db-integrity → watchdog → restart-check → self-healer →
browse-checker → skill-reloader → reminder-injector
```

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

### `/cron` Display

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

### Circuit Breaker

Track consecutive compaction failures per session. After 3 failures → stop trying, warn user "⚠️ Compaction failing — consider /reset". Reset counter on successful compaction or `/reset`.

### Auto-Reset on Overflow

If the model returns `ValidationException` or error code `-32603` (context too large):
1. Resets the ACP session immediately
2. Marks session for fresh session-start injection
3. Notifies user: "🔄 Context window full — session reset."

### Key Files

| File | Purpose |
|------|---------|
| `src/components/compaction.ts` | Compaction prompt + summary extraction |
| `src/components/session-memory.ts` | Memory context block builder |
| `src/components/message-pipeline.ts` | Graduated thresholds, auto-compact trigger, circuit breaker |
| `src/components/command-handlers.ts` | `/compact` command handler |

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
- Docker container management (`~/.agentbridge/browser-docker.sh start`)
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

Management script: `scripts/browser-docker.sh` → deployed to `~/.agentbridge/browser-docker.sh`

| Command | Description |
|---------|-------------|
| `browser-docker.sh build` | Build image + start container |
| `browser-docker.sh start` | Start container (existing image) |
| `browser-docker.sh stop` | Stop + remove container |
| `browser-docker.sh status` | Check if running |

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

## Deploy Wiring

All persona files and CLIs deployed via `scripts/deploy.sh` (supports `--quick` to skip build).

**Persona directories** (source: `persona/` in repo):

| Source | Deploy target | Override logic |
|--------|--------------|----------------|
| `persona/core/` (gitignored) | `~/.agentbridge/core/` | Personal files; falls back to `persona/core_templates/` for fresh installs |
| `persona/prompts/` | `~/.agentbridge/prompts/` | Always from repo |
| `persona/skills/` | `~/.agentbridge/skills/` | Always from repo |
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
Contains: `memory/`, `core/`, `skills/`, `prompts/`, `tasks/`, `topics/`, `reports/`, `finance/`.
Excludes: WAL/SHM files, pending state. Retention: 7 days (older auto-deleted).

### Git backup (remote)
Repository: `kiroprof-backup` on GitHub. Tracks text content only:
- `core/` — SOUL.md, TOOLS.md, user_profile.md, agent_notes.md
- `memory/daily|weekly|quarterly|retrospectives|audit` — summaries and reports
- `skills/`, `prompts/`, `tasks/` — agent behavior
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
| /cron | both | Scheduled tasks overview with status icons |
| /cron log \<id\> | both | Last 5 runs with exit codes for a task |
| /trigger \<id\> | both | Manually fire a cron task immediately |
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
