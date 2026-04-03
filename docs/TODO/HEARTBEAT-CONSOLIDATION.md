# Heartbeat Consolidation — Design Document

## Overview

Consolidate all periodic systems into a single heartbeat loop. The HB is the bridge's heart — it controls everything: task scheduling, standby detection, watchdog, session lifecycle. One loop, one mechanism.

## Current State (problems)

- Daily-restart: separate heartbeat task with DAY_START_HOUR, in-memory date tracking, .daily-restart-date file, 1h uptime guard
- Watchdog L0: runs doctor --fix mid-conversation (useless for hung tool calls)
- Evening doctor cron: separate 7pm schedule
- MIN_UPTIME_MS: separate guard, not synced to clock
- Multiple restart paths with different behaviors

## Design

### Clock-Synced Heartbeat

Ticks aligned to wall-clock boundaries based on interval:

```
nextBoundary = ceil(now / intervalMs) * intervalMs
delay = nextBoundary - now
if (delay < 3min) delay += intervalMs   // 3min guardrail
```

For 5min interval: ticks at :00, :05, :10, :15...
For 10min interval: ticks at :00, :10, :20...
Works for any interval. Replaces MIN_UPTIME_MS — the clock-sync delay IS the guard.

### Standby Detection

Track `lastTickAt` in tick(). If `gap = now - lastTickAt > intervalMs × 3` (~15min for 5min interval):

- Standby resume (Mac sleep/wake)
- HB bug/freeze
- Any process suspension

**Every detection triggers:** doctor --fix → delete bridge.lock → `process.exit(0)` → LaunchAgent restarts fresh.

No date check. Every standby resume = restart. Simple.

### 24h Fallback (always-on)

On each tick: if `bridge.lock.startedAt > 24h` AND no messages for >1h → same sequence (doctor → exit → restart). Covers Mac never sleeping.

### bridge.lock

`~/.agentbridge/bridge.lock` — JSON state file:
```json
{"pid": 12345, "startedAt": 1775225013194}
```

- Created on bridge startup
- Deleted before doctor-triggered exit
- No bridge.lock on startup = fresh start (post-restart)
- Read by doctor.sh for stale PID diagnostics

### Morning Sequence (Mac wakes at 8am)

```
8:00:00  Mac wakes, setInterval fires with 6h accumulated gap
         → tick: gap = 6h >> 15min → standby detected
         → doctor --fix (filesystem/DB health, local only)
         → delete bridge.lock → process.exit(0)
8:00:xx  LaunchAgent restarts bridge
         → no bridge.lock → fresh start → create bridge.lock
         → heartbeat start() → align to next clock boundary (≥3min)
8:05:00  First tick (clock-synced)
         → Dreamy triggers (≥8am, idle, no audit today)
8:05-8:30  Dreamy runs on fresh CLI
```

### What Triggers Bridge Restart

| Cause | Detection | Path |
|-------|-----------|------|
| Mac standby resume | HB gap > interval×3 | doctor → exit → LaunchAgent |
| HB bug/freeze | Same | Same |
| Always-on >24h + idle >1h | bridge.lock age | Same |
| Watchdog L2 (last resort) | In-session stuck after L1 failed | process.exit → LaunchAgent |
| Process crash | Process dies | LaunchAgent KeepAlive |

### What Does NOT Trigger Restart (in-session)

| Cause | Handler |
|-------|---------|
| Tool hung >3min | Watchdog Case 1: interrupt + explain |
| Silent >5min (rate limit) | Watchdog Case 3: re-send prompt |
| Model looping >10min | Watchdog Case 4: interrupt + explain |
| Context window full | Compaction system (#70) |
| User wants fresh | /reset command |

### Doctor Levels (updated)

| Level | What runs |
|-------|-----------|
| `doctor.sh` (diagnose) | All checks, no fixes |
| `--fix` (L1) | Stale locks, missing dirs, orphan processes, embedding, ollama |
| `--fix-full` (L2) | L1 + chmod 700, FTS rebuild, WAL checkpoint, git push check |

chmod 700 moved from L1 to L2 (not needed on every morning restart).

## Tasks

### Task 1: Clock-synced heartbeat
**File:** `src/components/heartbeat-system.ts`
- Replace `setInterval(tick, intervalMs)` with clock-aligned start
- `nextBoundary = ceil(now / intervalMs) * intervalMs`
- If delay < 3min, skip to next boundary
- Remove `MIN_UPTIME_MS` guard (replaced by clock-sync delay)
- Add `lastTickAt` tracking to `tick()`

### Task 2: Standby detection + onStandbyResume callback
**File:** `src/components/heartbeat-system.ts`
- At top of `tick()`: check `gap = now - lastTickAt > intervalMs * 3`
- If detected: log duration, call `config.onStandbyResume()` callback, return early (skip all tasks)
- Add `onStandbyResume?: () => void` to `HeartbeatConfig`

### Task 3: bridge.lock lifecycle
**File:** `src/bridge-app.ts`
- On startup: create `~/.agentbridge/bridge.lock` with `{pid, startedAt}`
- Wire `onStandbyResume`: `execSync("doctor.sh --fix")` → delete bridge.lock → `process.exit(0)`
- On each tick (new task or inline): check bridge.lock age >24h + idle >1h → same sequence

### Task 4: Remove daily-restart
**File:** `src/bridge-app.ts`
- Remove daily-restart heartbeat task
- Remove `DAY_START_HOUR` env parsing
- Remove `dailyRestartDate` / `dailyRestartFile` / `.daily-restart-date`
- Remove `logDebug` import if unused after removal

### Task 5: Doctor updates
**File:** `scripts/doctor.sh`
- Move chmod 700 (section 1) from `--fix` to `--fix-full`
- Add bridge.lock stale PID check (diagnose mode): read bridge.lock, check if PID is alive

### Task 6: Remove evening doctor cron
**On Mac:** `sqlite3 ~/.agentbridge/memory/memory.db "DELETE FROM cron_entries WHERE id='e5a301'"`

### Task 7: Log standby duration
**File:** `src/components/heartbeat-system.ts`
- `logInfo("heartbeat", "Standby resume detected — suspended ${gap}min")`

## Eliminates
- daily-restart heartbeat task
- `DAY_START_HOUR` env variable
- `.daily-restart-date` file
- `dailyRestartDate` / `dailyRestartFile` variables
- Evening doctor cron (7pm, entry e5a301)
- `MIN_UPTIME_MS` constant
- Watchdog L0 doctor (already removed in #73)
