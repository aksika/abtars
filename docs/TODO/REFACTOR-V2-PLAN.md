# System Engineering Refactor v2 — Plan

Branch: `refactor/system-engineering-v2`
Created: 2026-03-27

## Status

| Phase | Description | Status |
|-------|-------------|--------|
| A1 | `/trigger <id>` command | ✅ Done |
| A2 | Cron failure notifications | ✅ Done |
| A3 | Startup orphan kill | ✅ Done |
| A4 | Auto-restart launcher | ✅ Done |
| B1 | CronQueue reuses AcpTransport | ✅ Done |
| C1 | Cron state to SQLite | ✅ Done |
| C2 | `/cron log <id>` command | ✅ Done |
| D1 | Extract BridgeApp from main.ts | Deferred |
| D2 | Structured logging | Deferred |
| D3 | Dashboard static files | ✅ Done |
| E1 | Test coverage for critical files | Not started |

## Execution Order

### Phase A: Quick Wins (1-2 hours, immediate pain relief)

**A1. `/trigger <id>` command**
Manually fire a cron task from Telegram. No more resetting fireAt via python scripts.
- Add to command-handlers.ts: parse id, read cron.json, enqueue into cronQueue
- ~20 lines
- Risk: none

**A2. Cron failure notifications**
CronQueue sends ❌ message to Telegram on DoD fail or non-zero exit. Currently failures are silent.
- Already has `onComplete` callback — just distinguish success/failure in the message
- ~5 lines
- Risk: none

**A3. Startup orphan kill**
On bridge start, kill any `kiro-cli acp professor` processes not owned by current bridge.
- 5 lines in main.ts startup, before transport init
- Risk: none

**A4. Auto-restart in launcher**
`agentbridge.sh` wraps the bridge in a restart loop with backoff.
- `while true; do node ...; sleep 5; done` with max restart count
- ~10 lines in agentbridge.sh
- Risk: none

### Phase B: Core Fix (2-3 hours, eliminates the bug factory)

**B1. CronQueue reuses AcpTransport**
Delete 87-line hand-rolled JSON-RPC in `runAgent()`. Replace with fresh `AcpTransport` instance (same pattern as CodingMode).
- `transport.initialize()` → `transport.sendPrompt()` → `transport.destroy()`
- DoD checks stay as-is
- Kills entire class of protocol mismatch bugs (mcpServers, prompt format, future kiro-cli changes)
- ~50 lines changed
- Risk: low — CodingMode already proves this pattern

### Phase C: Data Integrity (3-4 hours)

**C1. Cron state to SQLite**
Move cron.json to a `cron_entries` table in existing memory.db.
- SQL queries with transactions — no more race conditions
- `agentbridge-cron` CLI reads/writes SQLite
- `checkCron()` and `recordRunToFile()` use DB
- Migration: import cron.json → SQLite on first run
- ~200 lines new, ~150 lines changed
- Risk: medium — touches cron CLI, checker, queue, command-handlers
- Depends on: B1

**C2. `/cron log <id>` command**
Show last run output for a task. Store last output in cron history (SQLite makes this easy).
- ~30 lines
- Depends on: C1

### Phase D: Code Quality (4-6 hours)

**D1. Extract BridgeApp from main.ts**
Create `BridgeApp` class — moves all wiring out of main.ts.
- main.ts becomes ~50 lines: parse args → create bridge → start → signals
- BridgeApp ~400 lines (moved, not new)
- Risk: medium — large move, no logic changes
- Depends on: B1, C1

**D2. Structured logging**
Replace custom logger with JSON output.
- `{ ts, level, tag, msg, ...context }` per line
- `LOG_FORMAT=text` env var for human-readable fallback
- ~30 lines new logger, ~200 lines mechanical changes
- Risk: low
- Depends on: D1

**D3. Dashboard static files**
Extract 1353 lines of inline HTML/CSS/JS from dashboard-ui.ts into `public/` folder.
- dashboard-server.ts serves static files + WebSocket
- ~1353 lines moved, ~50 lines new
- Risk: low
- Independent — can run anytime

### Phase E: Test Coverage (ongoing)

**E1. Tests for critical untested files**
Priority order:
1. `command-handlers.ts` (379 lines)
2. `acp-transport.ts` (261 lines)
3. `agent-api-server.ts` (337 lines)
4. `memory-extractor.ts` (283 lines)
5. `sleep-state-gatherer.ts` (310 lines)

~500-800 lines of tests. Independent — can run after any phase.

## Dependency Graph

```
A1 ─┐
A2 ─┤
A3 ─┼─ (all independent, do first)
A4 ─┘
     └─► B1 (core fix)
              └─► C1 (SQLite) ─► C2 (cron log)
              └─► D1 (BridgeApp) ─► D2 (structured logging)
         D3 (dashboard) ─ independent, anytime
         E1 (tests) ─ independent, ongoing
```

## Definition of Done per Phase

- All tests pass (642+)
- Type-check clean
- Deployed and live-tested
- Asbuilt docs updated
