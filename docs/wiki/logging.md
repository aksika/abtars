# Logging

## Log Levels

Set via `LOG_LEVEL` in `~/.abtars/config/.env`. Default: `low`.

| Level | What you'll see |
|-------|-----------------|
| `off` | Silent — nothing logged |
| `low` | Info + warnings + errors: boot phases, message delivery, tool calls, deploys, fallback activations, failures |
| `debug` | Low + verbose: prompt routing, session resolution, token counts, recall content, full payloads |
| `trace` | Debug + swallowed errors: every silent catch, failed probes, harmless timeouts |

```bash
# In ~/.abtars/config/.env
LOG_LEVEL=debug
```

## TRACE level

`LOG_LEVEL=trace` surfaces every error that's normally swallowed — including many **harmless** patterns:

- `[platform_detect] spawnSync ETIMEDOUT` — WSL journalctl probe timed out (sleep detection falls back to idle time)
- `[phase_transport] pkill ... Command failed` — no stale process to kill on clean boot (expected)
- `[skill-watcher] ENOENT` — optional skill file not present
- `[irc-client] ECONNREFUSED` — IRC server not running (non-critical service)

These are diagnostic noise at trace level, not bugs. Use TRACE when debugging a specific silent failure — don't leave it on permanently (log files grow fast).

## Log location

```
~/.abtars/logs/bridge-YYYY-MM-DD.log
```

Rotated daily. Retention controlled by `doctor.sh --fix` (default: 7 days).

## Useful grep patterns

```bash
# Errors only
grep "ERROR" ~/.abtars/logs/bridge-$(date +%F).log

# Swallowed errors (TRACE must be enabled)
grep "swallowed" ~/.abtars/logs/bridge-$(date +%F).log

# Message delivery
grep "Response delivered\|send failed" ~/.abtars/logs/bridge-$(date +%F).log

# Boot sequence
grep "✓\|✅\|ERROR" ~/.abtars/logs/bridge-$(date +%F).log | head -20
```
