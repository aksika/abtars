---
name: system-health
description: Run a system health check on Molty. Reads system-notes.md for known acceptable deviations before reporting.
user-invocable: true
---

# System Health Check

Run a comprehensive health check and report only **real issues** — not known/accepted deviations.

## Step 1 — Read known deviations

```
read docs/system-notes.md
```

Parse this file first. Any item described here is **expected** and must NOT be reported as an issue. Mention them briefly as "known & accepted" if relevant.

## Step 2 — Gateway health

Use the **gateway** tool:
```
gateway action=restart  (only if needed)
```

Or check via `session_status` for version/uptime info.

## Step 3 — Check system resources

Via `exec` (all allowlisted):
```bash
top -l 1 -n 0 | head -10
df -h /
uptime
```

## Step 4 — Check processes

```bash
ps aux | head -20
```

## Reporting

Produce a concise report with these sections:

1. **Status**: one-line overall (✅ healthy / ⚠️ degraded / 🔴 down)
2. **Services**: gateway, channels (Telegram/Discord) — up/down each
3. **Issues**: only NEW/UNEXPECTED problems (not in system-notes.md)
4. **Known & accepted**: one-line summary like "3 known deviations acknowledged, all expected"
5. **Resources**: disk, memory, uptime — only flag if concerning (disk >85%, etc.)

Keep it short. If everything is fine, say so in 3-4 lines.
