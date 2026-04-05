# Recovery Plan v2 — Final

## Problem
Standby resume handler restarts unconditionally on any gap > 15min. Power Nap wakes Mac every ~30min overnight → 10+ restarts per night, sleep interrupted, wasted API calls.

## Core Fix

### Change 1: Standby handler → checkDailyCycle
- Remove: unconditional `process.exit(0)`, `doctor --fix`, `bridge.lock` deletion
- Add: call shared `checkDailyCycle()` — restart only if past SLEEP_TIME
- If not daily cycle time → log DEBUG, return (bridge continues)
- Watchdog handles any transport breakage on next tick

### Change 2: Extract `checkDailyCycle()` shared function
- Currently inline in `createAgeCheckTask`. Extract to `src/components/daily-cycle.ts`
- Called by: standby handler, age-check heartbeat task
- Logic: past SLEEP_TIME? + started before? + idle? + not busy/sleeping? → restart

### Change 3: Platform wake detection
New file: `src/components/platform-detect.ts`

**macOS:**
```ts
execSync("pmset -g systemstate") → parse "DarkWake" | "FullWake"
```

**Linux (Ubuntu):**
```ts
// Check if systemd-suspend logged a resume within last 5 minutes
execSync("journalctl -b -u systemd-suspend.service -o short-unix --since '5 min ago' --no-pager")
// If entries exist → system just woke from suspend
// No entries → gap was NOT from suspend (process stall, network issue, etc.)
```

**Fallback:** return `"unknown"` → proceed to checkDailyCycle

Called before checkDailyCycle — if darkwake (macOS) → skip entirely (log DEBUG).

### Change 4: Remove standby grace period
No longer needed — bridge doesn't restart on standby.
Remove: bridge.lock `exitReason` check on startup, 3-min wait loop.

## Borrowed Patterns — Implementation Plan

### Pattern 1: Generic retryAsync (from OpenClaw)
New file: `src/components/retry.ts`
```ts
retryAsync<T>(fn, {
  attempts: 3,
  minDelayMs: 300,
  maxDelayMs: 30_000,
  jitter: 0.1,
  shouldRetry: (err) => boolean,
  retryAfterMs: (err) => number | undefined,
  onRetry: (info) => void,
})
```
Use for: transport reinit, model API calls, cron task failure injection.
Replaces: ad-hoc retry loops in acp-transport `promptWithRetry`, sleep `sendWithRetry`.

### Pattern 2: Permanent error detection (from OpenClaw)
```ts
const PERMANENT_ERRORS = [
  /auth.*fail|invalid.*key|unauthorized/i,
  /model.*not found|not supported/i,
  /account.*suspended|quota.*exceeded/i,
  /bot was blocked/i,
];
function isPermanentError(err: unknown): boolean
```
Use for: transport reinit (don't retry auth failures), cron failure injection (don't inject permanent errors to agent), model switching.

### Pattern 3: Escalating backoff (from OpenClaw + Hermes)
Backoff schedule: 5s → 30s → 2min → 5min cap. Max 5 attempts.
Use for: transport reinit after health check failure, platform reconnect.
Not pure exponential — practical steps that match real-world recovery times.

### Pattern 4: Typed restart reasons (inspired by OpenClaw heartbeat-reason)
```ts
type RestartReason =
  | "daily-cycle"
  | "standby-resume"    // only if checkDailyCycle triggers
  | "deploy"
  | "user-reset"
  | "watchdog-silent"
  | "watchdog-endless"
  | "ctx-overflow"
  | "manual";
```
Replace string-based `writeRestartReason()` with typed enum.
Enables: filtering logs by reason, metrics, pattern detection.

## Pending Items to Merge

### Gemini integration (#15-17 from GEMINI-INTEGRATION-PLAN.md)
- **Await startSession**: already in code (polling loop). Verify it works with Gemini's slow SOUL processing.
- **Context usage**: Gemini doesn't report `contextUsagePercentage`. Fallback: estimate from token counts in prompt response `_meta.quota`.
- **Session collision**: Gemini aborts previous prompt on new one. Our `await startSession` prevents this for startup. For runtime: ensure sequential prompts per session (busyChats guard already does this).

### Agent sandbox (#77)
- Phase 1: permission handler blocklist in `handlePermission()` — block writes outside `~/.agentbridge/`
- Deferred until recovery is stable.

### Deploy.sh .env preservation
- `deploy.sh` overwrote `AGENT_TRANSPORT_PROFILE=gemini` from `.env`
- Fix: deploy.sh should merge, not overwrite `.env` (or use `.env.local` for user overrides)

## E2E Tests

File: `src/tests/recovery-e2e.test.ts`

1. **Standby resume before SLEEP_TIME → no restart**
   - Simulate gap, clock before SLEEP_TIME
   - Verify: no process.exit, heartbeat continues

2. **Standby resume after SLEEP_TIME → daily cycle restart**
   - Simulate gap, clock after SLEEP_TIME, bridge.lock from yesterday
   - Verify: process.exit(0)

3. **Darkwake detection → skip entirely**
   - Mock detectWakeType → "dark"
   - Verify: no restart, no health check, DEBUG log only

4. **Sleep running during standby → no restart**
   - sleepChild active, simulate gap past SLEEP_TIME
   - Verify: no restart (sleep guard)

5. **Full overnight simulation**
   - 8 Power Nap wakes (gap every 30min), SLEEP_TIME=06:00
   - Verify: 0 restarts before 06:00, 1 restart at first tick after 06:00

## Implementation Order

1. Extract `checkDailyCycle()` + modify standby handler (core fix)
2. Platform detect (macOS + Linux)
3. Remove standby grace period
4. E2E tests
5. Generic retryAsync (replace ad-hoc retries)
6. Permanent error detection
7. Typed restart reasons
8. Gemini context usage fallback
9. Deploy.sh .env preservation
