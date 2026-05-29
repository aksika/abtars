# Resilience

abtars is designed to stay alive without babysitting. If something goes wrong — a crash, a network blip, a stale process — the system detects it and recovers automatically. You deploy once and it runs.

## Self-Healing Boot (Doctor)

Every time the bridge starts, a health check runs first. It verifies the environment is sane and fixes common issues before the bridge process launches.

**What it checks and repairs:**

| Issue | What happens |
|-------|--------------|
| Watchdog not loaded | Reinstalls and activates the OS supervisor |
| Wrong file permissions | Fixes sensitive directories to private (700) |
| Stale lock files | Removes orphaned locks from previous crashes |
| Missing directories | Recreates expected folder structure |
| Stuck background processes | Kills orphaned workers |

You never need to run this manually — it fires automatically on every boot, every restart, every deploy. If you want to run it yourself:

```bash
abtars doctor         # diagnose only (read-only, safe)
abtars doctor --fix   # diagnose + repair
```

## Watchdog

A lightweight process monitor watches the bridge. If the bridge crashes or becomes unresponsive, the watchdog kills it and spawns a fresh instance (which runs doctor first, so the new instance starts clean).

**Detection methods:**
- Heartbeat staleness — bridge writes a timestamp every 30s. If it goes stale, the bridge is stuck.
- Process death — PID disappears from the OS process table.

**Circuit breaker:** If the bridge crashes repeatedly (3+ times in 5 minutes), the watchdog stops trying and sends a notification. This prevents infinite crash loops from burning resources.

The watchdog itself is supervised by the OS (launchd on macOS, systemd on Linux). If the watchdog dies, the OS restarts it. Two layers of supervision — the bridge almost never stays dead.

## Runtime Self-Healer

A background log watcher that detects recurring errors and either auto-fixes them or notifies the owner.

**How it works:**

1. Tails the bridge log file in real-time
2. Matches ERROR lines against known patterns
3. For fixable patterns → runs an auto-fix action (e.g. restart a subsystem)
4. For unfixable patterns → sends a ⚠️ notification to the owner via Telegram

**Notification throttling:**

| Rule | Value |
|------|-------|
| Cooldown per error key | 2 hours (same error won't notify again within 2h) |
| Daily cap | 12 notifications/day total |
| Auto-fix circuit breaker | 3 failures → pauses auto-fix for that pattern (24h reset) |

**Auto-fix rules** are pattern-based. When a known error fires, the self-healer runs a predefined repair action. If the repair fails 3 times in a row, the circuit breaker trips and the owner gets a "paused" notification.

**Toggle:** `/healing` command enables/disables the self-healer. `/healing reset` clears circuit breakers.

## Model Fallbacks

If the primary AI model fails (rate limit, timeout, outage), the bridge automatically falls back to the next model in the chain. No user intervention needed — the response arrives from whichever model is healthy.

Fallback is per-agent and configurable:

```
Professor: gpt-5.4-mini → nemotron-3-super → minimax-m2.5
```

When the primary recovers, traffic returns to it automatically. The health registry tracks each model's reliability and promotes/demotes based on real-time success rates.

## Prompt Inactivity Timeout

If the model goes completely silent during a prompt (no text chunks, no tool calls, no events), the bridge kills the request after `PROMPT_TIMEOUT_SEC` (default: 180s / 3 minutes).

This is an **inactivity** timeout, not an absolute timeout. Every event from the model (tool call start, chunk, metadata) resets the clock. A model actively doing tool calls for 10 minutes won't be killed — only one that stops responding entirely.

On timeout: the prompt is rejected with "model unresponsive", the transport resets, and the user gets an error message. The next user message starts a fresh prompt.

| Env var | Default | Purpose |
|---------|---------|---------|
| `PROMPT_TIMEOUT_SEC` | `180` | Seconds of silence before killing a prompt |

## Network Resilience

Telegram polling uses exponential backoff with jitter. If the network drops:
- First retry: ~3 seconds
- Second retry: ~6 seconds
- Continues escalating up to 30 seconds between attempts

Once connectivity returns, polling resumes immediately. Messages sent during the outage are queued by Telegram and delivered on reconnection — nothing is lost.

## Deploy Without Downtime

`abtars update` stages the new release alongside the running one, then performs a quick restart. The bridge is down for under 2 seconds during the switch. The watchdog ensures it comes back up; doctor ensures it comes back healthy.

If a deploy introduces a crash, the circuit breaker catches it and the previous release remains staged for manual rollback.

## What You'll See

When everything is working (the common case):
```
🩺 Health check...
[doctor] Done. 0 fixes applied, 0 warnings.
♻️ Bridge starting...
✅ All systems healthy
```

When doctor self-heals something:
```
🩺 Health check...
[doctor] FIX: installed and loaded watchdog LaunchAgent
[doctor] Done. 1 fixes applied, 0 warnings.
♻️ Bridge starting...
✅ All systems healthy
```

No manual intervention needed in either case.
