# Process Supervision

How abTARS stays alive. Four layers of defense — each catches what the one below can't.

## Quick start

```bash
abtars start      # start bridge (foreground)
abtars stop       # stop bridge + watchdog
abtars restart    # restart bridge (rolling)
```

## 4-Layer Resilience Model

```
┌─────────────────────────────────────────────────────┐
│  L4: OS Service Manager (launchd / systemd)         │
│  Restarts watchdog on crash, starts on boot         │
├─────────────────────────────────────────────────────┤
│  L3: Watchdog Script (scripts/watchdog.sh)          │
│  Polls bridge.lock heartbeat every 30s              │
│  Kills + restarts bridge if heartbeat stale >60s    │
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
| L3 | Dead process, stale heartbeat, OOM kill | Kill + respawn bridge | 30-90s |
| L4 | Dead watchdog, system reboot | Respawn watchdog | On boot / immediate |

## What kills what

| Scenario | Caught by | Recovery time |
|----------|-----------|---------------|
| Unhandled exception | L3 (process exits, watchdog restarts) | ~5s |
| Event loop blocked (sync I/O hang) | L2 (timer fires, exits) → L3 restarts | 60-90s |
| OOM kill | L3 (process gone, heartbeat stale) | 30-60s |
| Watchdog crash | L4 (launchd/systemd restarts it) | ~5s |
| System reboot | L4 (starts on boot) | Boot time |
| `abtars stop` | Intentional — nothing restarts | Manual `abtars start` |
| `abtars stop --force` | Kills L3 + bridge. L4 does NOT restart (bootout) | Manual |

## macOS (launchd)

Installed automatically by `abtars install`:

```
~/Library/LaunchAgents/com.abtars.watchdog.plist
```

- `KeepAlive: true` — launchd restarts watchdog if it dies
- `RunAtLoad: true` — starts on login
- Watchdog runs bridge as a child process

### Commands

```bash
abtars start              # start bridge (watchdog manages it)
abtars stop --force       # stop everything (bootout from launchd)
abtars restart            # rolling restart (no downtime)
launchctl list | grep abtars   # verify launchd status
```

`--force` is required on macOS because without it, launchd respawns immediately.

## Linux (systemd)

User service at `~/.config/systemd/user/abtars-watchdog.service`:

```ini
[Unit]
Description=abTARS Watchdog

[Service]
ExecStart=%h/.abtars/watchdog.sh --all --web --agent --irc
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable abtars-watchdog
systemctl --user start abtars-watchdog
systemctl --user status abtars-watchdog
```

## bridge.lock

The heartbeat file at `~/.abtars/bridge.lock`. Written atomically (write .tmp → fsync → rename). Contains:

```json
{
  "pid": 12345,
  "startedAt": 1747563282000,
  "version": "0.1.0-8ea5f43",
  "sleepStatus": "awake",
  "argv": ["--all", "--web", "--agent", "--irc"],
  "lastHeartbeat": 1747563582000
}
```

The watchdog reads `lastHeartbeat` — if older than 60s, the bridge is considered dead.

## Health monitoring

The heartbeat tick (L1) runs these checks every 5 minutes:

| Task | What it checks |
|------|---------------|
| DB integrity | FTS5 index health |
| Transport health | Model API reachable |
| Model health | Bucket levels, cooldowns |
| Update check | New version available on npm |
| Bedtime | Quiet ticks for sleep trigger |
| Restart check | Pending restart flag in bridge.lock |

## User commands

```
/status       → uptime, PID, version, last heartbeat, model, sleep status
/doctor       → full health probe (memory, transport, ollama, permissions)
/model doctor → probe all configured models for availability
```

## Frozen watchdog (nuclear option)

If everything is stuck and `abtars stop --force` doesn't work:

```bash
# macOS
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.abtars.watchdog.plist
pkill -9 -f "watchdog.sh"
pkill -9 -f "node current"

# Linux
systemctl --user stop abtars-watchdog
pkill -9 -f "watchdog.sh"
pkill -9 -f "node current"
```

Then `abtars start` to bring it back cleanly.

## Doctor / Health Checks

`abtars doctor` runs a full runtime health check — verifying that everything the bridge needs is present and correctly configured.

### Automatic on boot

Doctor runs automatically before the bridge starts. If any probe fails, the bridge won't launch until the issue is resolved (or `--fix` repairs it).

### Probes

| Probe | What it checks |
|-------|---------------|
| `memory` | abmind DB exists, FTS index healthy |
| `telegram` | Bot token valid, API reachable |
| `discord` | Bot token valid, gateway reachable |
| `heartbeat` | bridge.lock writable, no stale PID |
| `dashboard` | Web dashboard port available |
| `ollama` | Ollama API reachable (if configured) |
| `transport` | Model API keys valid, endpoints respond |
| `core-files` | Required config files present |
| `secret-perms` | All secret files are chmod 600 |

### Usage

```bash
abtars doctor          # check everything, report pass/fail
abtars doctor --fix    # auto-repair what it can (permissions, missing dirs)
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | All probes passed |
| `1` | One or more failures |

### In-chat

```
/doctor       Run doctor live and report results in chat
```
