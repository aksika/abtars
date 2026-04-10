---
name: healthcheck
description: Self-diagnostics — check own health, logs, and state
user-invocable: false
---

# Healthcheck

Run these checks systematically when asked. Report ✅/⚠️/❌.

## 1. Doctor
```bash
~/.agentbridge/scripts/doctor.sh
```

## 2. Heartbeat
```bash
cat ~/.agentbridge/memory/.heartbeat  # epoch ms — if >10 min old, stalled
```

## 3. Cron
```bash
agentbridge-cron list                  # check lastRanAt, lastExit
agentbridge-cron history <id>          # drill into failures
```

## 4. Sleep
```bash
ls -lt ~/.agentbridge/memory/sleep/ | head -5   # last audit — if >2 days, broken
ls -la ~/.agentbridge/memory/sleep/*.lock 2>/dev/null  # stale locks
```

## 5. Memory DB
```bash
sqlite3 ~/.agentbridge/memory/memory.db "SELECT 'messages', COUNT(*) FROM messages UNION ALL SELECT 'extracted', COUNT(*) FROM extracted_memories;"
sqlite3 ~/.agentbridge/memory/memory.db "SELECT datetime(timestamp/1000, 'unixepoch', 'localtime'), substr(content,1,60) FROM messages ORDER BY timestamp DESC LIMIT 3;"
```

## 6. Consolidation
```bash
ls -lt ~/.agentbridge/memory/daily/ 2>/dev/null | head -3    # if >3 days, broken
ls -lt ~/.agentbridge/memory/weekly/ 2>/dev/null | head -3
```

## 7. Bridge logs
```bash
grep -i "error\|fail\|crash\|WARN" ~/.agentbridge/logs/bridge.log 2>/dev/null | tail -20
```

## 8. Backup
```bash
ls -lt ~/.backup-agentbridge/ 2>/dev/null | head -5  # should be <2 days old
```

## 9. Processes
```bash
ps aux | grep -E "agentbridge|kiro-cli" | grep -v grep
```

If issues found, suggest `doctor.sh --fix` or `doctor.sh --fix-full`.

## 10. Model Availability
```bash
# Check which models are configured
grep "AGENT_MAIN_MODEL\|AGENT_SLEEP_MODEL\|AGENT_BROWSE_MODEL\|AGENT_CODING_MODEL" ~/.agentbridge/transports/*.env 2>/dev/null
grep "AGENT_MAIN_MODEL" ~/.agentbridge/.env 2>/dev/null

# Ping each model (Direct API only)
curl -s http://localhost:11434/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"MODEL_NAME","messages":[{"role":"user","content":"hi"}],"max_tokens":1}' | head -c 200
```

Replace `MODEL_NAME` with each configured model. If 404 → model not found (wrong name). If 429 → rate limited. Subagents fall back to main model on failure.
