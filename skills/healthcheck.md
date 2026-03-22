---
name: healthcheck
description: Self-diagnostics — check own health, logs, and state
user-invocable: false
---

# Healthcheck Skill

When asked to do a healthcheck, self-diagnose, or check your own health, run through these checks systematically. Report findings clearly.

## 1. Run doctor

```bash
~/.agentbridge/scripts/doctor.sh
```

Read the output. Report any warnings.

## 2. Heartbeat liveness

```bash
cat ~/.agentbridge/memory/.heartbeat
```

Convert epoch ms to human time. If >10 min old, heartbeat may be stalled.

## 3. Cron health

```bash
agentbridge-cron list
```

For each recurring entry: check `lastRanAt` — is it recent? Check `lastExit` — any non-zero?

For entries with failures, drill into history:
```bash
agentbridge-cron history <id>
```

## 4. Sleep health

```bash
ls -lt ~/.agentbridge/memory/sleep/ | head -5
```

When was the last `sleep_*.md` audit? If >2 days, sleep isn't running.

Check for stale locks:
```bash
ls -la ~/.agentbridge/memory/sleep/*.lock 2>/dev/null
```

## 5. Memory DB health

```bash
# Row counts
sqlite3 ~/.agentbridge/memory/memory.db "SELECT 'messages', COUNT(*) FROM messages UNION ALL SELECT 'extracted', COUNT(*) FROM extracted_memories;"

# DB size
ls -lh ~/.agentbridge/memory/memory.db

# Most recent message (is recording working?)
sqlite3 ~/.agentbridge/memory/memory.db "SELECT datetime(timestamp/1000, 'unixepoch', 'localtime'), substr(content, 1, 60) FROM messages ORDER BY timestamp DESC LIMIT 3;"

# Most recent extraction (is sleep extracting?)
sqlite3 ~/.agentbridge/memory/memory.db "SELECT datetime(created_at/1000, 'unixepoch', 'localtime'), substr(content, 1, 60) FROM extracted_memories ORDER BY created_at DESC LIMIT 3;"

# FTS5 sanity (should return results if DB has data)
sqlite3 ~/.agentbridge/memory/memory.db "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'test OR hello OR good';"
```

## 6. Consolidation health

```bash
# Latest daily/weekly/quarterly summaries
ls -lt ~/.agentbridge/memory/daily/ 2>/dev/null | head -3
ls -lt ~/.agentbridge/memory/weekly/ 2>/dev/null | head -3
ls -lt ~/.agentbridge/memory/quarterly/ 2>/dev/null | head -3
```

If no daily summary in >3 days, consolidation isn't running during sleep.

## 7. Retrospective health

```bash
ls -lt ~/.agentbridge/memory/retrospectives/ 2>/dev/null | head -3
```

Should have recent `retro_YYYYMMDD.md` files if sleep is running.

## 8. Bridge log (last errors)

```bash
grep -i "error\|fail\|crash\|WARN" ~/.agentbridge/logs/bridge.log 2>/dev/null | tail -20
```

## 9. Backup health

```bash
ls -lt ~/.backup-agentbridge/ 2>/dev/null | head -5
```

Most recent `agentbridge-*.zip` should be <2 days old.

## 10. Process health

```bash
# Bridge process
ps aux | grep -E "agentbridge|kiro-cli" | grep -v grep

# tmux session
tmux ls 2>/dev/null
```

## Reporting

After running all checks, summarize:
- ✅ Healthy systems
- ⚠️ Warnings (degraded but functional)
- ❌ Failures (broken, needs fix)

If issues found, suggest specific fix commands (e.g., `doctor.sh --fix`, `doctor.sh --fix-full`, or manual steps).
