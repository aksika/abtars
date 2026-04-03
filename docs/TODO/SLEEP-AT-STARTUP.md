# Sleep at Startup — Design Document

## Overview

Move sleep from heartbeat task to bridge startup. Sleep runs once on every bridge start (if not already done today). Retry via setTimeout, not heartbeat. Eliminates the sleep-trigger heartbeat task and its state machine.

## Current State (problems)

- `SleepTrigger` class with `shouldRunOnStartup()` (dead), `shouldRunFromCron()`, attempt counter, cooldown timer, retry logic
- Heartbeat task `sleep-trigger` (heavy) — checks idle, checks audit, manages attempts
- Idle check (10min) — unnecessary at startup (nobody chatting at 8am)
- Attempt counter resets on bridge restart (in-memory)
- Complex interaction with heartbeat tick timing

## Design

### Startup Sleep

On bridge start, after `startSession()` greeting:

```
1. Check hasSleepAuditToday() → if yes, skip
2. Spawn agentbridge-sleep (background, non-detached)
3. On exit:
   - code 0: success, log it
   - code 2 (partial): retry after 5min via setTimeout
   - other: failure, retry after 5min via setTimeout
4. Max 3 attempts total, then stop
```

No heartbeat involvement. Sleep owns its own retry via `setTimeout`.

### Guard: Multiple Restarts Per Day

`hasSleepAuditToday()` checks for today's `.md` audit file. Once sleep succeeds, no re-run regardless of how many bridge restarts happen. Partial completions (lock file with failed steps) allow retry — catch-up system handles it.

### Sleep Queue

Still needed — if user messages during sleep, queue them. Activate on spawn, deactivate on exit. No change to `SleepQueue`.

### Flow

```
Bridge start:
  1. Init transport, memory, platforms
  2. Create bridge.lock
  3. startSession() → agent greets
  4. Start heartbeat (cron, watchdog, idle-compact, etc.)
  5. Sleep check: hasSleepAuditToday()? No → spawn sleep
     └─ exit 0: done
     └─ exit 2/fail: setTimeout(5min) → retry (max 3)
```

## Tasks

### Task 1: Move sleep spawn to bridge startup
**File:** `src/bridge-app.ts`
- After `startSession()` and `heartbeat.start()`, add sleep check + spawn
- Use existing spawn logic (from current sleep-trigger task)
- Retry via `setTimeout(5min)`, counter `sleepAttempts`, max 3
- Keep `sleepChild`, `sleepQueue.activate/deactivate`, exit handling

### Task 2: Remove sleep-trigger heartbeat task
**File:** `src/bridge-app.ts`
- Delete the `sleep-trigger` heartbeat task registration block
- Remove `sleepTrigger.shouldRunFromCron()` call
- Remove `sleepTrigger.writeLock()` call (sleep CLI writes its own JSON lock now)
- Remove idle check (lastMessageTs query)

### Task 3: Simplify SleepTrigger class
**File:** `src/components/sleep-trigger.ts`
- Keep: `hasSleepAuditToday()`, `getLastAuditAgeMs()`, `reportSuccess()`, `reportFailure()`
- Remove: `shouldRunOnStartup()` (already dead), `shouldRunFromCron()`, `writeLock()` (sleep CLI writes JSON lock)
- Remove: `attempts` counter, `lastFailureTime`, `RETRY_COOLDOWN_MS`, `MAX_ATTEMPTS`
- Class becomes a simple audit checker, not a trigger

### Task 4: Remove sleepActive from HeartbeatConfig
**File:** `src/components/heartbeat-system.ts`, `src/bridge-app.ts`
- Remove `sleepActive` callback from HeartbeatConfig
- Remove `sleepBlocking` check in `tick()`
- Sleep no longer blocks heavy heartbeat tasks (it's not a heartbeat task anymore)

Wait — heavy task blocking was for rate-limit protection. If sleep is running and a heavy cron agent task fires, both hit the model. Keep `sleepActive` for this reason.

Actually: sleep uses its OWN transport (separate kiro-cli). Cron agent tasks also use their own transport. They don't share the model endpoint necessarily... but they might share API rate limits. Keep `sleepActive` to be safe.

**Revised: Keep `sleepActive` in HeartbeatConfig.** Only remove the sleep-trigger task.

### Task 5: Clean up dead code
- Remove `SleepTrigger` import if class is reduced to just `hasSleepAuditToday()`
- Or inline `hasSleepAuditToday()` as a standalone function and delete the class
- Remove unused imports in bridge-app.ts

## Eliminates
- `sleep-trigger` heartbeat task
- `shouldRunFromCron()` method and its state machine
- `shouldRunOnStartup()` (already dead)
- `writeLock()` in SleepTrigger (sleep CLI writes JSON lock)
- Attempt counter / cooldown in SleepTrigger
- Idle check before sleep (10min lastMessageTs query)
- Complex heartbeat-sleep interaction

## Keeps
- `hasSleepAuditToday()` — guard against re-run
- `sleepChild` tracking — prevent duplicate spawns
- `sleepQueue` — queue user messages during sleep
- `sleepActive` in heartbeat — rate-limit protection for heavy tasks
- Sleep catch-up system (cross-day recovery)
- Sleep retry (3 attempts via setTimeout)
