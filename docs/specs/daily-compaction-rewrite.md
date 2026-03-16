# Daily Compaction Rewrite — OpenClaw-Inspired

## Problem Statement
Daily memory compaction is broken (4 bugs fixed earlier) and the architecture doesn't support per-day file separation or mid-conversation memory flushes. The directory structure is flat and fragile.

## Requirements
- Working directory per calendar day: `memory/working/YYYY-MM-DD/`
- Transcript compaction writes source files into the day's working directory
- Mid-conversation memory flush when context window fills up (OpenClaw pattern)
- Sleep cycle consolidates each past day's working directory into `daily/daily_YYYYMMDD.md` and deletes the working dir
- Crash recovery: any working dir older than today gets consolidated on startup
- Existing consolidation pipeline (daily→weekly→quarterly) reads from `daily/`

## How OpenClaw Does It → How We Adapt It

| OpenClaw | AgentBridge |
|----------|-------------|
| Agent writes to `memory/YYYY-MM-DD.md` live via file tools | `compact()` writes to `working/YYYY-MM-DD/transcript_<chatId>.md` |
| `memoryFlush` fires silent agentic turn before context compaction | Auto-compact at `contextPercent >= threshold` triggers `compact()` to flush to working dir |
| `/new` or `/reset` → `session-memory` hook saves snapshot | `/reset` → `shutdownCompaction` flushes to working dir |
| Heartbeat reviews daily files → updates `MEMORY.md` | Sleep cycle consolidates working dirs → `daily/daily_YYYYMMDD.md` |
| No batch catch-up needed (agent writes live) | Sleep cycle scans for stale working dirs (crash recovery) |

## Directory Layout

```
~/.agentbridge/memory/
  working/
    2026-03-08/                        ← today, accumulating
      transcript_7773842843.md         ← from auto-compact or heartbeat flush
    2026-03-07/                        ← stale (crash recovery candidate)
      transcript_7773842843.md
  daily/
    daily_20260306.md                  ← consolidated final
    daily_20260305.md
  weekly/
    2026-W09.md
  quarterly/
    2026-Q1.md
  transcripts/                         ← raw JSONL (unchanged)
    7773842843/
      telegram:7773842843.jsonl
```

## Three Write Paths Into the Working Directory

1. **Auto-compact (context window pressure)** — `main.ts:857`: when `contextPercent >= 70%`, calls `compactSession()` which writes to `working/YYYY-MM-DD/transcript_<chatId>.md`. This is the OpenClaw `memoryFlush` equivalent.

2. **Heartbeat daily-compaction task** — runs every 30 min, finds sessions with uncompacted messages past the day boundary, groups by calendar day, writes each day's summary to `working/YYYY-MM-DD/transcript_<chatId>.md`.

3. **Shutdown compaction** — on clean exit, flushes current session to today's working dir.

## One Consolidation Path Out of the Working Directory

4. **Sleep cycle daily-consolidation task** — scans `working/` for directories older than today, reads all `.md` files in each, LLM-consolidates into `daily/daily_YYYYMMDD.md`, deletes the working dir. Also runs on startup for crash recovery.

## Task Breakdown

### Task 1: Restructure `CompactionEngine.compact()` to write into working directory
- Change output path from `memory/daily/<chatId>/YYYY-MM-DD.md` to `memory/working/YYYY-MM-DD/transcript_<chatId>.md`
- Keep append behavior: if file exists in working dir, append with `---` separator
- DB `compactions` row still inserted (watermark tracking)
- `compactionDate` determines which working directory
- **Test:** `compact()` creates `working/2026-03-08/transcript_7773842843.md`

### Task 2: Add per-day message grouping to callers
- `createDailyCompactionTask`: group uncompacted messages by calendar day, call `compact()` per day
- `runStartupCatchUp`: same grouping, skip today's messages
- `shutdownCompaction`: flush to today's working dir (no day grouping needed — it's always "now")
- Add `groupMessagesByDay()` helper that splits messages by `YYYY-MM-DD` from their timestamps
- **Test:** 5-day gap → 5 separate source files in 5 working directories

### Task 3: Create daily-consolidation sleep task
- New file `src/components/daily-consolidation-task.ts`
- Scans `memory/working/` for date directories older than today
- For each stale directory:
  - Read all `.md` files
  - Concatenate with `---` separators
  - LLM-summarize with consolidation prompt
  - Write to `daily/daily_YYYYMMDD.md`
  - Insert DB record
  - Delete the working directory
- Register as heartbeat task `"daily-consolidation"` (runs after `daily-compaction`)
- Also export `runConsolidationCatchUp()` for startup
- **Test:** two stale working dirs → two `daily_*.md` files, working dirs deleted

### Task 4: Update `SleepCycleRunner` for new daily file layout
- `runWeeklyRollups()` reads from `memory/daily/` (no more `<chatId>` subdirectory)
- File pattern: `daily_YYYYMMDD.md` instead of `YYYY-MM-DD.md`
- Update `groupDailyByWeek()` to parse the new filename format
- **Test:** 7+ `daily_*.md` files trigger weekly rollup

### Task 5: Wire into `startHeartbeat()` and startup
- Register `daily-consolidation` task after `daily-compaction` in heartbeat
- Call `runConsolidationCatchUp()` on startup (after `runStartupCatchUp()`)
- Update auto-compact in `main.ts` to pass `compactionDate: new Date()` so it writes to today's working dir
- **Test:** full flow — auto-compact → working dir → sleep consolidation → daily file → weekly rollup

### Task 6: Update tests for new directory structure
- Update test helpers that create/check daily files to use new paths
- Update `compaction-engine.test.ts`, `sleep-cycle-runner.test.ts`, `memory-manager.test.ts`, `memory-e2e.test.ts`
- Verify all 465+ existing tests still pass with path changes
- **Demo:** `npm test` green, `npm run typecheck` clean

## Bugs Fixed (prerequisite, already applied)

1. `getUncompactedSessions` — changed from permanent session exclusion to watermark-based query
2. `runStartupCatchUp` — changed from empty `sessions` table to `messages` table query
3. `shutdownCompaction` — same watermark fix as #1
4. `compact()` — added `sinceTimestamp` filtering to only process new messages
