# Recovery Plan v2 — Unified Standby + Daily Cycle

## Problem
Standby resume handler restarts unconditionally on any gap > 15min. Power Nap wakes Mac every ~30min overnight → 10+ restarts per night. The SLEEP_TIME guard only exists in age-check, not in standby handler.

## Design

### Single recovery function: `checkDailyCycle()`

Called from two places, same logic:
1. **Standby resume** (gap detected in heartbeat)
2. **Heartbeat tick** (every 5min, covers always-on machines)

### Flow

```
Gap detected OR heartbeat tick:

  1. Platform check (optional optimization)
     - macOS: pmset → DarkWake? → log DEBUG, return
     - Linux/unknown: skip to step 2

  2. checkDailyCycle()
     - Past SLEEP_TIME? → No → return (just continue, watchdog handles breakage)
     - Bridge started before today's SLEEP_TIME? → No → return
     - Idle > 1h? → No → return
     - Busy chats or sleep active? → Yes → return
     - All conditions met → restart (daily cycle)
```

### What changes
- Standby handler: remove `process.exit(0)`, `doctor --fix`, `bridge.lock` deletion. Replace with `checkDailyCycle()`.
- Age-check task: replace with same `checkDailyCycle()` call.
- Remove standby grace period from startup (no longer needed).
- New file: `src/components/platform-detect.ts` — `detectWakeType()` for macOS darkwake.

### What stays
- Gap detection in heartbeat (logging + triggers checkDailyCycle)
- Watchdog (handles actual transport/process failures)
- SLEEP_TIME env var (daily cycle anchor)
- bridge.lock (diagnostics, not recovery logic)

### Recovery responsibility matrix

| Scenario | Handler | Action |
|----------|---------|--------|
| Power Nap wake (darkwake) | Platform detect | Skip entirely |
| Power Nap wake (fullwake) | checkDailyCycle | Continue (not past SLEEP_TIME) |
| Real wake after overnight | checkDailyCycle | Restart if past SLEEP_TIME |
| Always-on, past SLEEP_TIME | checkDailyCycle (via tick) | Restart |
| Transport dead | Watchdog | Reinit transport |
| Model silent | Watchdog | Re-send prompt, then exit |
| Tool hung | Watchdog | Interrupt, then reset |
| Power cut | Fresh start | LaunchAgent/systemd starts bridge |
| Ctx overflow | Pipeline catch | resetAndPrepare |

### Config
- `SLEEP_TIME=06:00` — existing, no change
- No new env vars
- Platform detection is automatic
