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

The runtime self-healer supplies bounded log signals to SHA; it does not own
agent sessions, fix execution, or incident state.

### Log-based (background watcher)

A heartbeat task tails the bridge log and forwards eligible records to SHA.
SHA applies the configured mode, classification, durable deduplication, and
known-fix policy before any action is considered.

**How it works:**

1. Tails the bridge log file with a durable cursor
2. Normalizes, redacts, and bounds eligible ERROR records
3. Sends one typed signal to SHA; duplicate cursor keys are ignored
4. SHA either suppresses, recommends a verified known fix, or opens a staged
   incident for supervised RCA/design/solution work

**Notification throttling:**

| Rule | Value |
|------|-------|
| Incident identity | Durable fingerprint + event key in SQLite |
| Known-fix cooldown | Per-rule `cooldownMin` in `sha_fault_state` |
| Operator reset | `/healing reset` clears known-fix counters |

Known-fix rules are pattern-based. Automatic execution requires `full` mode,
`verified: true`, an argv-only action, and an independent verifier. Action exit
zero is not reported as fixed; only a successful verifier produces
`known_fix_verified`.

`/healing` reports operational state. Use `/healing reset` to clear durable
known-fix counters; mode changes require configuration and a bridge restart.

### SHA: Self-Healing Agent

When a scheduled task fails, SHA records a durable incident and may dispatch
supervised Pi coding workers according to the configured mode.

**Enable/disable:**

```bash
# Investigation: RCA and design only
SELFHEAL_MODE=investigation

# Full: RCA, design, and isolated solution proposal
SELFHEAL_MODE=full

# Disable (or remove the line; default: off)
SELFHEAL_MODE=off
```

SHA also requires `~/.abtars/config/sha-policy.json` (seeded automatically during install). If the policy file is missing, SHA auto-disables at boot with a single log message — no repeated warnings. To re-enable: restore the policy file and restart the bridge.

Mode changes take effect after restart. `/healing` is read-only; policy
actions remain available as `/healing reset|list|approve|disable`.

**Flow:**

1. Task fails → user sees `⚠️ <task> failed`
2. SHA classifies the failure and emits one bounded admission outcome
3. Unknown actionable failures create one supervised `O` incident with
   sequential RCA → design → (full only) solution workers
4. The existing Orc review accepts or blocks the proposal; SHA never applies
   generated code to the canonical checkout

**Incident concurrency and identity:**

| Condition | Result | Rationale |
|-----------|--------|-----------|
| Same event key | No second notice or incident mutation | Exactly-once source replay |
| Same fingerprint, active episode | Attach and increment occurrence count | One active episode per fault |
| New known-fix event during cooldown | Recommendation only | Avoid repeated automatic action |

**What SHA can and cannot do:**

SHA workers use only the configured disposable `sha` Git checkout with
`projectTrust="never"`. RCA/design must leave it clean; solution evidence is
copied privately and the checkout is restored. SHA never applies generated
patches to the canonical checkout or writes `.env`, secrets, runtime state,
deployment roots, or other protected files.

**Known-fix policy:** Pattern rules live in
`~/.abtars/config/sha-policy.json`; self-generated rules use
`sha-policy-self.json` and remain recommendation-only until approved with a
verifier.

**Isolation:** SHA stages run through supervised Worker contracts in the fixed
`sha` workspace alias, separate from the canonical checkout and user session.

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

## Stress Tests (verified 2026-06-17)

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
