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

Two self-healing paths that keep the bridge healthy without human intervention.

### Log-based (background watcher)

A heartbeat task that detects recurring errors in the bridge log and either auto-fixes them or notifies the owner.

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

### SHA: Self-Healing Agent

When a scheduled task fails, a dedicated self-healing agent session diagnoses and attempts to fix the issue programmatically.

**Enable/disable:**

```bash
# Enable (add to ~/.abtars/config/.env)
SELFHEAL_ENABLED=true

# Disable
SELFHEAL_ENABLED=false    # or remove the line (default: off)
```

SHA also requires `~/.abtars/config/sha-policy.json` (seeded automatically during install). If the policy file is missing, SHA auto-disables at boot with a single log message — no repeated warnings. To re-enable: restore the policy file and restart the bridge.

Or at runtime: `/healing` command toggles the self-healer on/off. `/healing reset` clears circuit breakers.

**Flow:**

1. Task fails → user sees `⚠️ <task> failed`
2. SHA fires in an isolated `_S_` (System) session → user sees `🔧 Calling self-healing agent`
3. SHA diagnoses root cause and attempts programmatic fix
4. If fixed → task succeeds on next tick
5. If unfixable → SHA reports `"Requires human intervention: <reason>"`
6. After 3 consecutive failures → task auto-pauses, user sees `⛔ Needs manual fix`

**Three-state concurrency guard:**

| State | On failure | Rationale |
|-------|-----------|-----------|
| `idle` | Fire SHA with all pending failures | Normal path |
| `running` | Drop entirely (no count, no notify) | SHA might be fixing it right now |
| `cooldown` (60s) | Count + notify, skip SHA | Let fix propagate before retrying |

**What SHA can and cannot do:**

SHA is forbidden from modifying vital config files (`transport.json`, `.env`, `peers.json`, `users.json`) unless the bridge is in a crash loop. It can fix JSON corruption, pause tasks, and repair scripts. The full rules are in its system prompt at `src/boot/phase-pipeline-deps.ts`.

**Auto-fix whitelist:** Pattern-based rules live in `src/components/self-healer/`. When a known error matches, a predefined repair action runs. Custom rules can be added there.

**Isolation:** SHA runs in a System session (`_S_` type) — no access to user memory, no memory storage, minimal SOUL prompt. Cannot pollute the user's conversation context.

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

## Deploy With Auto-Rollback

`abtars update` stages new code into a separate directory, then atomically swaps it in. After restart, it verifies the bridge actually came back healthy. If not — automatic rollback.

**The flow:**
```
Build → Stage → Atomic swap → Restart → Health probe (60s) → ✓ or rollback
```

**What happens on failure:**

If the bridge doesn't produce a heartbeat within 60 seconds of restart:
1. The new code is moved aside (`app.broken/`)
2. The previous working version is restored (`app.prev.1/` → `app/`)
3. Bridge restarts again from the known-good code
4. If THAT also fails → stops and prints diagnostics

You never end up with a dead bot from a bad deploy. The system either runs new code or automatically falls back to old code — within 90 seconds, no manual intervention.

**Remote deploy (Telegram):**
```
/update pull          ← git pull latest code
/update deploy         ← build + deploy + health verify + auto-rollback
```

**What You'll See on success:**
```
⏳ Updating (build)...
✓ staged 0.2.1-alpha.10
✓ atomic swap
♻️ Restarting bridge...
✓ Bridge healthy (PID 19735)
```

**What You'll See on failure (auto-rollback):**
```
⏳ Updating (build)...
✓ staged 0.2.1-alpha.10
✓ atomic swap
♻️ Restarting bridge...
❌ Bridge unhealthy after 60s. Auto-rolling back...
✓ Rolled back to previous version.
```

## What You'll See

When everything is working (the common case):
```
🩺 Health check...
[doctor] Done. 0 fixes applied, 0 warnings.
♻️ Bridge starting...
✓ All systems healthy
```

When doctor self-heals something:
```
🩺 Health check...
[doctor] FIX: installed and loaded watchdog LaunchAgent
[doctor] Done. 1 fixes applied, 0 warnings.
♻️ Bridge starting...
✓ All systems healthy
```

No manual intervention needed in either case.

## Stress Tests (verified 2026-06-17, KP + Molty)

The watchdog singleton system (#1035) and instant-death detection (#1042) were stress-tested on both hosts:

| # | Scenario | Expected | Result | Recovery |
|---|----------|----------|--------|----------|
| 1 | Kill watchdog | Bridge stays alive, new WD can start + adopt | ✓ | 0s (bridge unaffected) |
| 2 | Start duplicate watchdog | "Watchdog already running", exits | ✓ | — |
| 3 | Kill bridge | Watchdog detects + respawns | ✓ | ~25s |
| 4 | Delete bridge.lock | Watchdog self-heals: recreates file + spawns | ✓ | ~55s |
| 5 | Corrupt bridge.lock | Same as missing: self-heal + spawn | ✓ | ~60s |
| 6 | Kill zombie watchdog (non-owner) | Exits without killing bridge | ✓ | 0s |
| 7 | `abtars stop` | Both die cleanly, file preserved | ✓ | — |
| 8 | Deploy corrupt bundle | Instant-death → circuit breaker → auto-rollback | ✓ | ~70s |
| 9 | Start 2nd watchdog (systemd race) | PID guard blocks before flock, exits 0 | ✓ | — |

### Protection stack

```
Bridge heartbeat    → detects own deadlock     → exits (L2 restarts)
Watchdog poll (60s) → detects dead/stale bridge → kill + respawn
Watchdog spawn wait → detects instant-death     → double-count → fast rollback
Circuit breaker     → 3 failures in 180s        → auto-rollback to app.prev.1
flock singleton     → prevents duplicate WD     → second instance exits
Ownership trap      → zombie WD can't kill      → exits without damage
launchd/systemd     → WD dies for any reason    → respawns WD → adopts bridge
```
