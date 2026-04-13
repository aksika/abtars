# #10 Watchdog Dark Wake Restart Bug — Fix

**Date:** 2026-04-13
**Status:** Planned
**Priority:** HIGH
**Type:** Bugfix

## Problem

After Mac sleep, Node.js fires batched `setInterval` callbacks on resume. The watchdog's 60s timer fires many times in rapid succession, each decrementing `wdCountdown -= 60_000`. The countdown drains past `WD_GRACE_MS` before the heartbeat's 5min timer gets a chance to fire and call `kickWatchdog()`. Result: unnecessary restart at ~03:00 every night.

## Root cause

Countdown pattern (`wdCountdown -= interval`) is vulnerable to setInterval batching. N queued callbacks each subtract 60s = N×60s drained instantly.

## Fix

Replace countdown with wall-clock comparison. `Date.now() - lastKickAt` gives the same answer regardless of how many batched callbacks fire. Add `classifyResume()` at the kill threshold to distinguish dark wake (suppress) from real failure (kill).

```
Heartbeat (5min)
     │
kicks every tick
     │
     ▼
┌─────────────────────┐
│  lastKickAt = now   │
└─────────────────────┘
     ▲
     │ reads
     │
┌─────────────────────┐
│  Watchdog (60s)     │
│                     │
│  elapsed = now -    │
│    lastKickAt       │
│                     │
│  ≤ 15min → healthy  │
│  > 15min →          │
│    classifyResume() │
│    dark  → suppress │
│    else  → exit(1)  │
└─────────────────────┘
```

## Why wall-clock is equivalent to countdown

Both run on the same event loop. Neither can detect a fully blocked event loop from within. The countdown doesn't give hardware-watchdog semantics — it just looks like it does. Wall-clock detects the same failures (heartbeat stopped ticking) without the batching vulnerability.

See #130 for future external watchdog process (separate concern).

## Implementation

**File:** `src/bridge-app.ts`

Replace:
```typescript
const WD_COUNTDOWN_MS = hbIntervalMs * 3;
let wdCountdown = WD_COUNTDOWN_MS;
const kickWatchdog = (): void => { wdCountdown = WD_COUNTDOWN_MS; };
// ...
const WD_CHECK_INTERVAL = 60_000;
const WD_GRACE_MS = -60_000;
setInterval(() => {
  wdCountdown -= WD_CHECK_INTERVAL;
  if (wdCountdown <= WD_GRACE_MS) { ... exit(1) }
}, WD_CHECK_INTERVAL);
```

With:
```typescript
const WD_THRESHOLD_MS = hbIntervalMs * 3;       // 15min
const WD_CHECK_INTERVAL = 60_000;
let lastKickAt = Date.now();
const kickWatchdog = (): void => { lastKickAt = Date.now(); };
// ...
setInterval(() => {
  const elapsed = Date.now() - lastKickAt;
  if (elapsed <= WD_THRESHOLD_MS) return;
  const kind = classifyResume();
  if (kind === "dark") { lastKickAt = Date.now(); return; }
  logWarn("watchdog", `No heartbeat kick for ${Math.round(elapsed / 60000)}min (${kind}) — forcing restart`);
  writeRestartReason("watchdog: no heartbeat kick");
  process.exit(1);
}, WD_CHECK_INTERVAL);
```

**Deletes:** `wdCountdown`, `WD_COUNTDOWN_MS`, `WD_GRACE_MS`.

**`onStandbyResume`:** Keep for logging, remove `kickWatchdog()` call (watchdog handles its own dark wake suppression now).

## Edge cases

- Dark wake + stuck heartbeat → suppressed. Dark wakes are brief — next full wake catches it.
- NTP clock jump forward → could trigger false positive. Acceptable — restart is safe, rare.
- `classifyResume()` hangs → 3s timeout in execSync. Worst case: 3s delay before kill.
- DST changes → `Date.now()` is UTC, unaffected.

## Estimate

~15 min
