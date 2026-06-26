# Process Supervision

How abTARS stays alive. Four layers of defense — each catches what the one below can't.

## Quick start

```bash
abtars start      # start bridge + watchdog
abtars stop       # stop bridge + watchdog (.stopped sentinel)
```

## 4-Layer Resilience Model

```
┌─────────────────────────────────────────────────────┐
│  L4: OS Service Manager (launchd / systemd)         │
│  Restarts watchdog on crash, starts on boot         │
├─────────────────────────────────────────────────────┤
│  L3: Watchdog Script (scripts/watchdog.sh, 59 lines)│
│  Polls bridge alive + heartbeat every 60s           │
│  Kills + restarts bridge if heartbeat stale >5min   │
├─────────────────────────────────────────────────────┤
│  L2: In-Process Timer (60s wall-clock check)        │
│  Detects frozen event loop (setTimeout never fires) │
│  Exits with code 1 → L3 restarts                   │
├─────────────────────────────────────────────────────┤
│  L1: Heartbeat System (5-min tick)                  │
│  Writes timestamp to bridge.lock every tick         │
│  Runs health tasks (DB integrity, transport, etc)   │
└─────────────────────────────────────────────────────┘
```

| Layer | Detects | Recovery | Speed |
|-------|---------|----------|-------|
| L1 | Normal operation | Writes heartbeat, runs tasks | Every 5 min |
| L2 | Frozen event loop, infinite sync loop | `process.exit(1)` | 60s max |
| L3 | Dead process, stale heartbeat, OOM kill | Kill + respawn bridge | 62-65s |
| L4 | Dead watchdog, system reboot | Respawn watchdog | On boot / immediate |

## Circuit breaker (in bridge, NOT in watchdog)

On bridge boot (`boot/circuit-breaker.ts`):
1. Read `~/.abtars/watchdog.state` (timestamps of recent deaths)
2. If 4+ deaths within 7 minutes → auto-rollback (destroy pattern)
3. Delete `app/`, promote `app.prev.1` → cascade to prev.2, prev.3
4. All slots exhausted → write `.stopped`, exit

The watchdog is dumb — it just respawns. The bridge decides whether to self-heal.

## What kills what

| Scenario | Caught by | Recovery time |
|----------|-----------|---------------|
| Unhandled exception | L3 (process exits, watchdog restarts) | ~62s |
| Event loop blocked (sync I/O hang) | L2 (timer fires, exits) → L3 restarts | 60-120s |
| OOM kill (SIGKILL) | L3 (process gone) | ~62s |
| Crash loop (4 in 7min) | Bridge boot circuit breaker → auto-rollback | ~62s |
| Watchdog crash | L4 (launchd/systemd restarts it) | ~5s |
| System reboot | L4 (starts on boot) | Boot time |
| `abtars stop` | Intentional — .stopped sentinel, nothing restarts | Manual `abtars start` |

## Duplicate prevention

- **Watchdog:** flock (Linux) / lockf (macOS) on `~/.abtars/.bridge.flock`. Second instance exits.
- **Bridge:** On boot, reads `bridge.lock.pid`. If that PID is alive → exits immediately.

## Start reason

Every bridge boot records WHY it started in `bridge.lock.startReason`:

| Reason | Who writes it |
|--------|---------------|
| `watchdog-respawn` | Default (watchdog, no .start-reason file) |
| `update:<commit>` | `abtars update` |
| `manual-rollback:<slot>:<ver>` | `/software rollback` |
| `auto-rollback:<slot>:<ver>` | Circuit breaker |
| `user-restart` | `/restart` command |

## Deploy restart

`abtars update` sends SIGTERM to bridge PID directly. Watchdog sees process gone → respawns with new code (files already swapped). No USR1, no watchdog reload.

## macOS (launchd)

```
~/Library/LaunchAgents/com.abtars.watchdog.plist
```

- `KeepAlive: true` — restarts watchdog on crash
- `RunAtLoad: true` — starts on login

## Linux (systemd)

```
~/.config/systemd/user/abtars-watchdog.service
```

- `Restart=on-failure`, `RestartSec=5`

## bridge.lock

```json
{
  "pid": 12345,
  "watchdogPid": 67890,
  "startedAt": 1747563282000,
  "version": "0.3.0-alpha.1-abc1234",
  "sleepStatus": "awake",
  "lastHeartbeat": 1747563582000,
  "startReason": "update:abc1234"
}
```

Watchdog READS `lastHeartbeat` (stale check) and `pid` (alive check). Bridge WRITES all fields.

## Rollback

Two modes:
- **Manual** (`/software rollback N`): SWAP — `app/ ↔ app.prev.N/`. Reversible, broken version preserved for debugging.
- **Auto** (circuit breaker): DESTROY — `rm -rf app/`, `mv app.prev.N app/`. Emergency, slots stay clean.

## Nuclear option

If everything is stuck:

```bash
pkill -9 -f "watchdog.sh"
pkill -9 -f "node.*abtars.js"
rm -f ~/.abtars/.stopped
abtars start
```
