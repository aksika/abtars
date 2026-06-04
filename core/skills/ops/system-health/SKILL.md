---
name: system-health
description: Run a system health check. Reads system-notes.md for known acceptable deviations before reporting.
user-invocable: true
---

# System Health Check

Run a comprehensive health check and report only **real issues** — not known/accepted deviations.

## Step 0 — Read known deviations

```
read docs/system-notes.md
```

Parse this file first. Any item described here is **expected** and must NOT be reported as an issue. Mention them briefly as "known & accepted" if relevant.

## Step 1 — Doctor

```bash
~/.abtars/scripts/doctor.sh
```

## Step 2 — Heartbeat

```bash
cat ~/.abtars/memory/.heartbeat  # epoch ms — if >10 min old, stalled
```

## Step 3 — Cron / Tasks

```bash
# Use /tasks command or:
cat ~/.abtars/memory/cron-state.json
```

## Step 4 — Sleep cycle

```bash
ls -lt ~/.abtars/memory/sleep/ | head -5   # last audit — if >2 days, broken
ls -la ~/.abtars/memory/sleep/*.lock 2>/dev/null  # stale locks
```

## Step 5 — Memory DB

```bash
sqlite3 ~/.abtars/memory/memory.db "SELECT 'messages', COUNT(*) FROM messages UNION ALL SELECT 'extracted', COUNT(*) FROM extracted_memories;"
sqlite3 ~/.abtars/memory/memory.db "SELECT datetime(timestamp/1000, 'unixepoch', 'localtime'), substr(content,1,60) FROM messages ORDER BY timestamp DESC LIMIT 3;"
```

## Step 6 — Consolidation

```bash
ls -lt ~/.abtars/memory/daily/ 2>/dev/null | head -3    # if >3 days, broken
ls -lt ~/.abtars/memory/weekly/ 2>/dev/null | head -3
```

## Step 7 — Bridge logs

```bash
grep -i "error\|fail\|crash\|WARN" ~/.abtars/logs/bridge.log 2>/dev/null | tail -20
```

## Step 8 — Backup

```bash
ls -lt ~/.backup-abtars/ 2>/dev/null | head -5  # should be <2 days old
```

## Step 9 — Processes

```bash
ps aux | grep -E "abtars|kiro-cli|ollama" | grep -v grep
```

## Step 10 — System resources

```bash
top -l 1 -n 0 | head -10
df -h /
uptime
```

## Step 11 — Model availability

```bash
# Check configured models from transport.json
python3 ~/.abtars/scripts/scout-ollama.py
```

## Reporting

Produce a concise report:

1. **Status**: one-line overall (✅ healthy / ⚠️ degraded / 🔴 down)
2. **Services**: gateway, channels (Telegram/Discord) — up/down each
3. **Issues**: only NEW/UNEXPECTED problems (not in system-notes.md)
4. **Known & accepted**: one-line summary like "3 known deviations acknowledged, all expected"
5. **Resources**: disk, memory, uptime — only flag if concerning (disk >85%, etc.)

Keep it short. If everything is fine, say so in 3-4 lines.

If issues found, suggest `doctor.sh --fix` or `doctor.sh --fix-full`.
