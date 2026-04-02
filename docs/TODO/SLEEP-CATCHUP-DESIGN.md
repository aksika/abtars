# Sleep Catch-Up & Lock File Lifecycle

## Problem

When a sleep cycle fails partway through, the current resume logic re-runs failed steps on the next trigger **same day only**. If the day rolls over, a fresh lock is created and the previous day's failures are silently abandoned. This causes data loss for time-sensitive steps (daily summary, extraction, retrospective) whose data can't be regenerated from a new day's run.

Additionally, the extraction watermark advances unconditionally — even when `04a-daily-summary` or `04b-extract-from-daily` failed — meaning those messages are marked as "processed" despite never being summarized or extracted.

Old lock files accumulate indefinitely with no cleanup.

## Design

### Step Classification

**Essential (time-sensitive)** — data is lost if skipped:
| Step | Why |
|------|-----|
| `04a-daily-summary` | Summarizes that day's conversations. No file = no extraction. |
| `04b-extract-from-daily` | Extracts memories from daily summary. Depends on 04a. |
| `retrospective` | Reviews recent conversations for lessons. Covering multiple days is fine. |
| `retro-extract` | Extracts from retrospective. Depends on retrospective. |

**Idempotent (catch-up naturally)** — today's run covers yesterday's missed work:
| Step | Why |
|------|-----|
| `gc-noise`, `cron-verify`, `topic-reorg` | Operates on current DB state |
| `darwinism`, `core-knowledge`, `translation-check` | Prunes/reviews current memories |
| `anomaly-audit`, `merge`, `consolidation` | Cumulative maintenance |
| `media-cleanup`, `report` | Cumulative / informational |

### Catch-Up Flow

On sleep start, **before** today's cycle:

```
1. Scan sleep/ dir for lock files older than today
2. For each previous lock (newest first, max 3 days back):
   a. Parse lock file → check essential steps
   b. If all essentials are "ok" or "skipped" → delete lock (cleanup)
   c. If any essential step is "failed"/"timeout"/"pending":
      - Run only the failed essential steps (skip idempotent ones)
      - Update the previous lock file with results
      - If all essentials now ok → delete lock
      - If still failing → keep lock, log WARNING
3. Proceed with today's normal sleep cycle
```

### Watermark Fix

Move watermark advance inside the `dreamySucceeded` gate:

```
Before (current):
  // Always advances — even if 04a/04b failed
  watermark.advance(now)

After:
  if (dreamySucceeded) {
    watermark.advance(now)
  }
```

This ensures messages aren't marked "processed" until they've actually been summarized and extracted. On the next sleep run, `readMessages` will pick them up again.

### Lock File Lifecycle

```
Day 1: sleep runs → lock created → all ok → lock stays (audit)
Day 2: sleep starts → checks Day 1 lock → essentials ok → deletes Day 1 lock
                     → runs Day 2 cycle → lock created

Day 1: sleep runs → 04a fails → lock stays with failed status
Day 2: sleep starts → checks Day 1 lock → 04a failed → runs 04a catch-up
                     → 04a succeeds → deletes Day 1 lock
                     → runs Day 2 cycle normally

Day 1: sleep runs → 04a fails
Day 2: catch-up fails again → lock stays, WARNING logged
Day 3: catch-up fails again → lock stays, WARNING logged (2 consecutive)
Day 4: lock is 3+ days old → ERROR logged, lock deleted (data too stale)
```

### Warning Pattern Detection

When a catch-up attempt fails, log includes:
- Step name
- How many consecutive days it has failed
- Original failure date

```
WARN [sleep] Catch-up failed: 04a-daily-summary (failing since 2026-04-01, 2 consecutive days)
ERROR [sleep] Abandoning stale lock sleep_20260401.lock — essential steps failed 3+ days, data unrecoverable
```

### Catch-Up Context for Retro

Retrospective catch-up covers all messages since the last successful retrospective — whether that's 1 day or 3 days. The prompt already works with a message window, not a fixed date. More coverage = more lessons learned. No special handling needed.

### Daily Summary Catch-Up

For catch-up of a previous day's `04a-daily-summary`:
- **Must use date-range filtering**, not watermark. If watermark wasn't advanced (per our fix), `readMessages(watermarkTs)` returns ALL unprocessed messages (Day 1 + Day 2 combined). That would put both days' content into `daily_2026-04-01.md`, then today's 04a would read the same messages again → duplicates.
- Catch-up: `WHERE timestamp BETWEEN dayStart AND dayEnd` (midnight-to-midnight of the failed day)
- Today's run: uses watermark as normal
- Write the daily file with the **original date**: `daily_2026-04-01.md`
- The watermark stays put until today's full sleep succeeds

## Changes Required

1. **`agentbridge-sleep.ts`** — move watermark advance inside `if (dreamySucceeded)` block
2. **`agentbridge-sleep.ts`** — add catch-up phase before main step loop:
   - Scan for previous lock files (not today's)
   - For each: check essential steps (`04a-daily-summary`, `04b-extract-from-daily`, `retrospective`, `retro-extract`)
   - If any essential failed/timeout/pending → run only those steps with previous day's context
   - If all essentials now ok → delete previous lock file
   - If still failing → keep lock, log WARNING with step name + consecutive failure count
   - 3-day retention cap: locks older than 3 days with failures → log ERROR, delete (data too stale)
   - Locks older than 1 day with all essentials ok + report written → delete (cleanup)
3. **`agentbridge-sleep.ts`** — pass target date to `buildDailySummary` / `writeDailyFile` for catch-up (write `daily_2026-04-01.md` not today's date)
4. **`agentbridge-sleep.ts`** — warn on missing daily files: if a previous day had messages but no `daily_YYYYMMDD.md`, log WARNING (catch-up will generate it)
5. **`agentbridge-sleep.ts`** — track consecutive failures per step across lock files: if same step fails 2+ days, escalate log level
6. **`sleep-trigger.ts`** — no changes needed (catch-up is internal to the sleep process)

## Not In Scope

- Decoupling daily summary from sleep cycle (rejected — adds complexity)
- Per-step resume for idempotent steps (unnecessary — they catch up naturally)
- Cross-day lock conflict prevention (already handled by `sleepChild` in-memory guard)
