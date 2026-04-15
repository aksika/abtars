# #130 External Watchdog Process

**Date:** 2026-04-16
**Status:** Planning
**Priority:** HIGH
**Repo:** agentbridge

## Problem

The in-process watchdog (heartbeat task) cannot detect event loop deadlocks. If the Node.js event loop freezes — stuck promise, native addon deadlock, ACP reinit race — the watchdog never fires because it runs inside the same frozen loop.

### Real incident: 2026-04-16 00:50

**Timeline:**
```
00:50:13 — Bridge running, kiro-cli receives SIGTERM (from deploy pkill)
00:50:13 — [acp-main] Sending prompt to session b76a6e48...
00:50:16 — [acp-main] kiro-cli exited (code=null, signal=SIGTERM)
00:50:16 — [acp-main] Unexpected kiro-cli exit — auto-reinitializing in 5s
00:50:16 — [acp-main] ACP initialized (agent: Kiro CLI Agent)
00:50:16 — [acp-main] Prompt complete (stopReason: end_turn, ctx: 8%)
00:50:16 — ✅ Startup session ready
00:55:00 — [heartbeat] Tick — executing 8 task(s)
           ← LAST ACTIVITY. Bridge process alive (PID 53716) but completely silent.
           ← No more heartbeat ticks. No Telegram polling. No responses.
           ← bridge.lock shows lastHeartbeat stuck at 00:55.
01:14:00 — User notices bridge is dead (~19 minutes of downtime)
01:15:29 — Manual restart attempt, hits transient ACP error
01:15:30 — Bridge shuts down (port conflict with zombie process?)
01:15:31 — LaunchAgent restarts, bridge comes up clean
```

**Root cause:** kiro-cli was killed mid-prompt (SIGTERM from deploy). The ACP auto-reinit recovered the connection, but a pending `sendPrompt()` promise from the killed session was never resolved/rejected. The event loop hung waiting on this dead promise. The heartbeat timer was registered but never fired because the event loop was blocked.

**Why in-process watchdog failed:** The watchdog is a heartbeat task — it runs inside `setInterval`. If the event loop is frozen, `setInterval` callbacks don't fire. The watchdog can't detect its own death.

**Impact:** 19 minutes of silent downtime. Bridge process appeared alive (`ps aux` showed it running), but was completely unresponsive. No Telegram messages processed, no heartbeat, no cron tasks.

## Goal

A separate process that monitors the bridge from outside. Detects:
- Event loop deadlock (heartbeat stale)
- Process crash (PID gone)
- OOM freeze (process alive but unresponsive)
- Startup failure (bridge never writes first heartbeat)

## Design

### Architecture

```
agentbridge-watchdog (parent)
  └── agentbridge (child, the bridge)
```

The watchdog is a lightweight process that:
1. Spawns the bridge as a child process
2. Reads `bridge.lock` every 60s
3. If `lastHeartbeat` is older than 10 minutes → kill + restart
4. If child PID is gone → restart
5. Logs to `~/.agentbridge/logs/watchdog.log`

### Detection logic

```
every 60s:
  lock = read("~/.agentbridge/bridge.lock")
  
  if lock.pid not running:
    log("Bridge process gone — restarting")
    restart()
  
  if now - lock.lastHeartbeat > STALE_THRESHOLD (10 min):
    log("Heartbeat stale for {age}min — killing PID {lock.pid}")
    kill(lock.pid, SIGKILL)  // SIGKILL, not SIGTERM — process may be frozen
    restart()
  
  if now - lock.startedAt < 60s && !lock.lastHeartbeat:
    // Bridge just started, give it time
    skip
```

### Key decisions

- **SIGKILL not SIGTERM** — a frozen event loop won't handle SIGTERM. Must use SIGKILL.
- **10 minute threshold** — heartbeat interval is 5 min. 2 missed ticks = definitely dead. Allows for slow ticks (heavy cron tasks can take minutes).
- **bridge.lock is the contract** — no new IPC mechanism. The bridge already writes `lastHeartbeat` on every tick. The watchdog just reads it.
- **No watchdog-of-the-watchdog** — the watchdog is a trivial loop (read file, compare timestamp, maybe kill). If it crashes, LaunchAgent/systemd restarts it.

### LaunchAgent integration (macOS)

Replace the current bridge LaunchAgent with a watchdog LaunchAgent:

```xml
<!-- com.agentbridge.watchdog.plist -->
<key>ProgramArguments</key>
<array>
  <string>/Users/akos/.agentbridge/agentbridge-watchdog.sh</string>
  <string>--all</string>
  <string>--web</string>
  <string>--agent</string>
</array>
<key>KeepAlive</key>
<true/>
```

The watchdog script spawns the bridge. If the watchdog itself dies, LaunchAgent restarts it, which restarts the bridge.

### systemd integration (Linux/WSL)

Same pattern — systemd runs the watchdog, watchdog runs the bridge.

### Graceful deploy

Deploy should signal the watchdog, not the bridge directly:
```bash
# deploy.sh
kill -USR1 $(cat ~/.agentbridge/watchdog.pid)
# Watchdog receives USR1 → gracefully stops bridge → restarts it
```

This avoids the "pkill kills kiro-cli mid-prompt" problem that caused tonight's incident.

## Implementation

| Step | What | Effort |
|---|---|---|
| 1 | `agentbridge-watchdog.sh` — bash script: spawn bridge, poll bridge.lock, kill+restart on stale | 30 min |
| 2 | USR1 handler — graceful restart (SIGTERM bridge, wait, respawn) | 15 min |
| 3 | Watchdog logging to `~/.agentbridge/logs/watchdog.log` | 10 min |
| 4 | Update `deploy.sh` — signal watchdog instead of pkill | 15 min |
| 5 | macOS LaunchAgent plist for watchdog | 10 min |
| 6 | Update `agentbridge.sh` launcher to use watchdog mode | 15 min |
| 7 | Test: simulate frozen bridge (kill -STOP), verify watchdog recovers | 15 min |
| **Total** | | **~2 hr** |

## What This Does NOT Cover

- In-process ACP promise timeout (separate fix — should reject pending promises on kiro-cli exit)
- Graceful ACP reinit state cleanup (separate fix — clear busy flags, session map)
- Multiple bridge instances (watchdog manages exactly one)
