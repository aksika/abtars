# Recovery Plan v2 — Unified Standby + Daily Cycle

## Problem
Standby resume handler restarts unconditionally on any gap > 15min. Power Nap wakes Mac every ~30min overnight → 10+ restarts per night. The SLEEP_TIME guard only exists in age-check, not in standby handler.

## Root Cause
Two separate code paths handle the same scenario differently:
- Standby handler: gap detected → always restart (no time check)
- Age-check: gap detected → restart only if past SLEEP_TIME

A skipped heartbeat tick IS a problem — but only if the OS wasn't sleeping. If the OS was sleeping, the skip is expected and harmless.

## Design

### Single recovery function: `checkDailyCycle()`

Called from two places, same logic:
1. **Standby resume** (gap detected in heartbeat)
2. **Heartbeat tick** (every 5min, covers always-on machines)

### Flow

```
Gap detected OR heartbeat tick:

  1. Platform check (optional, fast)
     - macOS: pmset -g systemstate → DarkWake? → log DEBUG, return
     - Linux: /sys/power/state or loginctl → suspended? → log DEBUG, return
     - Unknown: skip to step 2

  2. checkDailyCycle()
     - Past SLEEP_TIME? → No → continue running (don't restart)
     - Bridge started before today's SLEEP_TIME? → No → continue
     - Idle > 1h? → No → continue
     - Busy chats or sleep active? → Yes → continue
     - All conditions met → restart (daily cycle)

  3. Health check (if NOT restarting)
     - transport.isReady? → Yes → all good, continue
     - No → attempt reinit with exponential backoff
     - Reinit succeeded → continue
     - Reinit failed after max attempts → restart as last resort
```

### Borrowed from Hermes

**Exponential backoff for transport recovery:**
- 30s → 60s → 120s → 240s → 300s cap
- Max 20 attempts then give up (restart)
- Non-retryable errors (auth failure) → restart immediately

**Health monitor pattern (from Hermes Signal platform):**
- Don't assume broken just because time passed
- Actively check if connection is alive before taking action
- Only force reconnect if health check fails

**Pre-advance pattern (from Hermes cron scheduler):**
- Mark step as "running" before execution
- If process crashes mid-run, recurring tasks don't re-fire
- One-shot tasks retry on restart
- We already do this with sleep lock files — validate it's consistent

### What changes
- Standby handler: remove unconditional `process.exit(0)`, `doctor --fix`, `bridge.lock` deletion
- Replace with: platform check → `checkDailyCycle()` → health check
- Age-check task: replace with same `checkDailyCycle()` call
- Remove standby grace period from startup (no longer needed)
- Add exponential backoff to transport reinit
- New file: `src/components/platform-detect.ts`

### What stays
- Gap detection in heartbeat (logging + triggers recovery flow)
- Watchdog (handles tool hung, silent, endless — separate from standby)
- SLEEP_TIME env var (daily cycle anchor)
- bridge.lock (diagnostics)

### Recovery responsibility matrix

| Scenario | Detection | Action |
|----------|-----------|--------|
| DarkWake (macOS) | Platform detect | Skip entirely |
| Power Nap (fullwake, before SLEEP_TIME) | checkDailyCycle | Continue, health check |
| Real wake after overnight (past SLEEP_TIME) | checkDailyCycle | Restart + sleep |
| Always-on, past SLEEP_TIME | checkDailyCycle (via tick) | Restart + sleep |
| Transport dead after resume | Health check | Reinit with backoff |
| Transport dead, reinit fails | Health check exhausted | Restart |
| Tool hung > 3min | Watchdog | Interrupt → reset |
| Model silent > 5min | Watchdog | Re-send → exit |
| Active > 10min (loop) | Watchdog | Interrupt → reset |
| Process dead | Watchdog | Reinit → re-send |
| Ctx overflow | Pipeline catch | resetAndPrepare |
| Power cut | Fresh start | LaunchAgent/systemd |

### Config
- `SLEEP_TIME=06:00` — existing, no change
- No new env vars
- Platform detection is automatic

### Open questions
- Should health check run on every tick or only after gap detection?
- Should we log platform wake type at INFO for overnight diagnostics?
- Backoff state: in-memory (resets on restart) or persisted?

### Patterns borrowed from OpenClaw

**Generic retry with policy (`retry.ts`):**
- `retryAsync<T>(fn, { attempts, minDelayMs, maxDelayMs, jitter, shouldRetry, retryAfterMs })`
- `shouldRetry(err)` — classify errors as retryable or permanent
- `retryAfterMs(err)` — extract delay from rate limit headers
- Jitter via secure random to break convoy patterns
- We should build a similar `retryAsync` for transport reinit and model calls

**Permanent error detection (`delivery-queue-recovery.ts`):**
- `PERMANENT_ERROR_PATTERNS` — regex list of known-unrecoverable errors
- Auth failures, "bot was blocked", "chat not found" → stop retrying immediately
- For us: auth errors, invalid model, account suspended → don't retry, alert user

**Escalating backoff (not pure exponential):**
- OpenClaw: 5s → 25s → 2min → 10min (4 steps, practical)
- Hermes: 30s → 60s → 120s → 240s → 300s cap (exponential with cap)
- Our choice: escalating with cap. 5s → 30s → 2min → 5min cap. Max 5 attempts.

**Typed wake reasons (`heartbeat-reason.ts`):**
- `retry | interval | manual | exec-event | wake | cron | hook`
- Instead of just "gap detected", know WHY the heartbeat fired
- Helps diagnostics: "was this a Power Nap wake or a manual restart?"
- We should add: `standby-resume | daily-cycle | deploy | user-reset | watchdog`

**Wake coalescing (`heartbeat-wake.ts`):**
- Multiple wake requests within 250ms merged into one tick
- Priority: retry > interval > manual
- Prevents thundering herd after standby resume

**Recovery budget:**
- Don't spend unlimited time recovering — cap total recovery time
- Defer remaining items if budget exceeded
- For us: if transport reinit takes > 2min, give up and restart

### Recovery E2E Tests

Tests that verify the full recovery flow with real components (mock transport/CLI only).

**File: `src/tests/recovery-e2e.test.ts`**

**Test 1: "standby resume before SLEEP_TIME — no restart"**
- Create real HeartbeatSystem with real tasks
- Simulate gap > threshold (advance clock)
- Set time before SLEEP_TIME
- Verify: no process.exit, heartbeat continues ticking

**Test 2: "standby resume after SLEEP_TIME — daily cycle restart"**
- Same setup, set time after SLEEP_TIME
- Bridge.lock startedAt = yesterday
- Verify: process.exit(0) called (daily cycle)

**Test 3: "darkwake detection skips entirely (macOS)"**
- Mock `detectWakeType()` → return "dark"
- Simulate gap
- Verify: no restart, no health check, just log + continue

**Test 4: "transport dead after resume — reinit with backoff"**
- Mock transport.isReady = false
- Simulate gap (not daily cycle time)
- Verify: transport.initialize() called
- Mock first reinit fails, second succeeds
- Verify: backoff delay between attempts

**Test 5: "transport reinit exhausted — restart"**
- Mock transport.isReady = false, all reinit attempts fail
- Verify: process.exit(0) after max attempts

**Test 6: "permanent error — immediate restart, no retry"**
- Mock transport reinit throws auth error (matches PERMANENT_ERROR_PATTERNS)
- Verify: process.exit(0) immediately, no backoff

**Test 7: "watchdog catches silent after standby resume"**
- Simulate gap → bridge continues (no restart)
- Transport is "ready" but model is silent
- Verify: watchdog fires after WATCHDOG_SILENT_SEC, re-sends prompt

**Test 8: "sleep not interrupted by standby resume"**
- Sleep is running (sleepChild active)
- Simulate gap
- Verify: no restart (sleep guard), sleep continues

**Test 9: "full overnight simulation"**
- Simulate 8 hours of Power Nap wakes (gap every 30min)
- SLEEP_TIME = 06:00
- Verify: 0 restarts before 06:00, 1 restart at 06:00, sleep spawned after restart

### Open questions
- Should health check run on every tick or only after gap detection?
- Should we log platform wake type at INFO for overnight diagnostics?
- Backoff state: in-memory (resets on restart) or persisted?
