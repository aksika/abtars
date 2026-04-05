# Recovery Plan v2 — Final

## Problem
Standby resume handler restarts unconditionally on any gap > 15min. Power Nap wakes Mac every ~30min overnight → 10+ restarts per night, sleep interrupted, wasted API calls.

## Naming Convention
All names are distinct from OpenClaw/Hermes to avoid confusion across codebases.

| Concept | Our name |
|---|---|
| Retry wrapper | `withRetry` |
| Retry config | `RetryPolicy` |
| Error retryable check | `isRecoverable` |
| Delay hint from error | `getDelayHint` |
| Known-fatal patterns | `FATAL_PATTERNS` / `isFatal` |
| Daily cycle check | `isDailyCycleDue` |
| Wake classification | `classifyResume` |
| Restart reason type | `RestartCause` |

## Core Fix

### Change 1: Standby handler → isDailyCycleDue
- Remove: unconditional `process.exit(0)`, `doctor --fix`, `bridge.lock` deletion
- Add: call shared `isDailyCycleDue()` — restart only if past SLEEP_TIME
- If not daily cycle time → log DEBUG, return (bridge continues)
- Watchdog handles any transport breakage on next tick

### Change 2: Extract `isDailyCycleDue()` shared function
New file: `src/components/daily-cycle.ts`
- Called by: standby handler, age-check heartbeat task
- Logic: past SLEEP_TIME? + started before? + idle? + not busy/sleeping? → restart

### Change 3: Platform wake detection
New file: `src/components/platform-detect.ts`

`classifyResume(): "dark" | "full" | "unknown"`

**macOS:**
```ts
execSync("pmset -g systemstate") → parse "DarkWake" | "FullWake"
```

**Linux (Ubuntu):**
```ts
// Check if systemd-suspend logged a resume within last 5 minutes
execSync("journalctl -b -u systemd-suspend.service -o short-unix --since '5 min ago' --no-pager")
// Entries exist → system woke from suspend → treat as "full" (no darkwake on Linux)
// No entries → gap was NOT from suspend → "unknown"
```

**Fallback:** return `"unknown"` → proceed to isDailyCycleDue

Flow on skipped heartbeat tick:
```
L1: classifyResume()
  → "dark" → DEBUG log, done
  → "full" | "unknown" → L2

L2: isDailyCycleDue()
  → true → restart (daily cycle + sleep)
  → false → DEBUG log, continue (watchdog handles breakage)
```

### Change 4: Remove standby grace period
No longer needed — bridge doesn't restart on standby.
Remove: bridge.lock `exitReason` check on startup, 3-min wait loop.

## Transport-Agnostic Fixes

### Change 5: Non-blocking startup session with message queueing
Problem: `await startSession()` blocks the bridge for 4+ min on slow transports. Any transport could be slow — not Gemini-specific.

Fix:
- `startSession()` runs in background (fire-and-forget)
- New `sessionReady` flag per session key
- Inbound messages before session ready → queue with "⏳ Starting up..." reply
- Session completes → replay queued messages
- Timeout: 5 min → mark ready anyway, log WARN

This replaces the current polling loop (`while (!sessionReady)`) with a proper queue — same pattern as the old sleep queue but for startup.

### Change 6: Context usage fallback
Problem: some transports don't report `contextUsagePercentage` (Gemini returns -1%).

Fix:
- If transport reports -1% → estimate from token counts in response metadata
- If no token counts available → disable ctx-dependent features (floating compaction, ctx warnings)
- Log WARN once: "Context usage unavailable — compaction disabled"
- Don't break — gracefully degrade

## Borrowed Patterns — Implementation Plan

### Pattern 1: `withRetry` + `RetryPolicy`
New file: `src/components/retry.ts`
```ts
interface RetryPolicy {
  attempts: number;       // default 3
  minDelayMs: number;     // default 300
  maxDelayMs: number;     // default 30_000
  jitter: number;         // default 0.1 (10%)
  isRecoverable?: (err: unknown) => boolean;
  getDelayHint?: (err: unknown) => number | undefined;
  onAttempt?: (info: { attempt: number; err: unknown; delayMs: number }) => void;
}

function withRetry<T>(fn: () => Promise<T>, policy?: Partial<RetryPolicy>): Promise<T>
```

Replaces:
- `acp-transport.ts` `promptWithRetry` (3 attempts, 2s fixed delay)
- `agentbridge-sleep.ts` `sendWithRetry` (2 retries, transient error check)
- `bridge-app.ts` sleep spawn retry (3 attempts, 5min delay)

### Pattern 2: `FATAL_PATTERNS` + `isFatal`
```ts
const FATAL_PATTERNS = [
  /auth.*fail|invalid.*key|unauthorized/i,
  /model.*not found|not supported/i,
  /account.*suspended|quota.*exceeded/i,
  /bot was blocked/i,
];
function isFatal(err: unknown): boolean
```
Use for:
- Transport reinit: don't retry auth failures
- Cron failure injection: don't inject permanent errors to agent
- `withRetry` default `isRecoverable`: `!isFatal(err)`

### Pattern 3: Escalating backoff
Built into `withRetry` via `minDelayMs` + `maxDelayMs`:
- Default: 300ms → 600ms → 1.2s → ... → 30s cap
- Transport reinit: 5s → 30s → 2min → 5min cap (custom policy)
- Jitter prevents convoy patterns

### Pattern 4: `RestartCause` typed enum
```ts
type RestartCause =
  | "daily-cycle"
  | "deploy"
  | "user-reset"
  | "watchdog-silent"
  | "watchdog-endless"
  | "ctx-overflow"
  | "manual";
```
Replace string-based `writeRestartReason()`.
Enables: log filtering, pattern detection, metrics.

## Pending Items

### Agent sandbox (#77)
- Phase 1: permission handler blocklist in `handlePermission()` — block writes outside `~/.agentbridge/`
- Deferred until recovery is stable.

### Deploy.sh .env preservation
- `deploy.sh` overwrote `AGENT_TRANSPORT_PROFILE=gemini` from `.env`
- Fix: use `.env.local` for user overrides (never overwritten by deploy)

## E2E Tests

File: `src/tests/recovery-e2e.test.ts`

1. **Standby resume before SLEEP_TIME → no restart**
   - Simulate gap, clock before SLEEP_TIME
   - Verify: no process.exit, heartbeat continues

2. **Standby resume after SLEEP_TIME → daily cycle restart**
   - Simulate gap, clock after SLEEP_TIME, bridge.lock from yesterday
   - Verify: process.exit(0)

3. **Darkwake detection → skip entirely**
   - Mock classifyResume → "dark"
   - Verify: no restart, DEBUG log only

4. **Sleep running during standby → no restart**
   - sleepChild active, simulate gap past SLEEP_TIME
   - Verify: no restart (sleep guard)

5. **Full overnight simulation**
   - 8 Power Nap wakes (gap every 30min), SLEEP_TIME=06:00
   - Verify: 0 restarts before 06:00, 1 restart at first tick after 06:00

File: `src/tests/startup-e2e.test.ts`

6. **Slow transport startup — messages queued**
   - Mock transport that takes 3s to respond to startSession
   - Send message during startup
   - Verify: "Starting up..." reply, message replayed after session ready

7. **Startup timeout — proceed anyway**
   - Mock transport that never responds
   - Verify: after 5min timeout, bridge accepts messages

File: `src/tests/retry.test.ts`

8. **withRetry succeeds on second attempt**
9. **withRetry stops on fatal error**
10. **withRetry respects delay hint from error**
11. **withRetry applies jitter**

## Implementation Order

1. Extract `isDailyCycleDue()` + modify standby handler (core fix)
2. `classifyResume()` — platform detect (macOS + Linux)
3. Remove standby grace period
4. Non-blocking startup session with message queueing
5. Context usage fallback (-1% handling)
6. Recovery + startup E2E tests (tests 1-7)
7. `withRetry` + `RetryPolicy` + tests (replace ad-hoc retries)
8. `FATAL_PATTERNS` + `isFatal`
9. `RestartCause` typed enum
10. Deploy.sh .env preservation (`.env.local`)
