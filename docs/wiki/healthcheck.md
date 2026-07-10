# Health Check

Quick commands to verify your bridge is healthy and troubleshoot common issues.

## Is it running?

```bash
abtars status           # shows bridge state, version, mode, daemon, TUI
```

Expected (daemon install):
```
  mode:          daemon
  bridge:        ● running (pid 1234)
  daemon:        abtars (system)
                 ● active (running) since ...
                 pid: 1230
  tui:           ✓ present (enabled=true, branch=yes, bridge tty=none)
```

In chat: `/status` returns the same operator view + runtime (transport, model, context%, platforms, etc.) — see `managing.md`.

## Doctor

```bash
abtars doctor           # checks permissions, config, DB, services
abtars doctor --fix     # auto-fix what it can
```

Doctor checks:
- File permissions (secrets 600, config 600)
- Required dirs exist
- Config files present
- Memory DB accessible
- Ollama reachable
- Embedding model available

## Logs

```bash
# Live bridge log
tail -f ~/.abtars/logs/bridge-$(date +%F).log

# Last 20 errors
grep ERROR ~/.abtars/logs/bridge-$(date +%F).log | tail -20

# Systemd journal (daemon mode)
journalctl -u abtars --since "10 min ago"

# Watchdog log
tail -20 ~/.abtars/logs/launchd.log
```

## Common checks

### Telegram not responding

```bash
# Is Telegram polling?
grep "Telegram polling started" ~/.abtars/logs/bridge-$(date +%F).log | tail -1

# Token loaded?
grep "overridden" ~/.abtars/logs/bridge-$(date +%F).log | tail -1
# Should show "N overridden" where N > 0 (secrets loaded)

# 409 conflict (another instance polling same token)?
grep "409" ~/.abtars/logs/bridge-$(date +%F).log | tail -3
```

### Memory not working

```bash
# Memory enabled?
grep "Memory enabled" ~/.abtars/logs/bridge-$(date +%F).log | tail -1

# Symlink exists?
ls -la ~/.abtars/current/node_modules/abmind

# Key file exists?
ls ~/.abmind/secret/abmind.key
```

### Model errors

```bash
# Model health
grep "model-health" ~/.abtars/logs/bridge-$(date +%F).log | tail -5

# Demotions
grep "demote" ~/.abtars/logs/bridge-$(date +%F).log | tail -5

# Transport type
grep "Transport ready\|ACP transport\|Direct API" ~/.abtars/logs/bridge-$(date +%F).log | tail -3
```

### Bridge keeps restarting

```bash
# Restart reasons
grep "restart\|SIGTERM\|exit" ~/.abtars/logs/bridge-$(date +%F).log | tail -10

# Circuit breaker (too many restarts)
grep "circuit" ~/.abtars/logs/bridge-$(date +%F).log | tail -3

# Watchdog state
grep "Suspend\|grace\|Killing" ~/.abtars/logs/launchd.log | tail -5
```

## Quick fixes

| Problem | Fix |
|---|---|
| Bridge dead, service active | `abtars restart` |
| Stale PID / EADDRINUSE | `abtars stop --force && abtars start` |
| Secrets not decrypting | Check `~/.abmind/secret/abmind.key` exists (run `abmind install`) |
| Model 404 / demoted | `abtars update` (clears demotions) |
| Memory unavailable | `abmind install` then restart |
| Permissions wrong | `abtars doctor --fix` |
| Soul missing | Check `~/.abmind/memory/core/SOUL.md` exists |

## Full reset (nuclear option)

```bash
abtars stop --force
rm -rf ~/.abtars ~/.abmind
# Then re-install from scratch (see install page)
```
