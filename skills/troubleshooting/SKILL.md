---
name: troubleshooting
description: Diagnostic commands for debugging bridge subsystems
user-invocable: false
---

# Troubleshooting Skill

Diagnostic commands for when things go wrong. Use these to investigate issues before asking the user or escalating.

## Bridge Process

```bash
# Is the bridge alive?
ps aux | grep 'dist/main.js' | grep -v grep

# Bridge child processes (kiro-cli ACP sessions)
pgrep -P $(pgrep -f 'dist/main.js') | xargs ps -p -o pid,stat,etime,cmd

# Check bridge logs (last 50 lines, skip DB init spam)
tail -c 20000 ~/.agentbridge/logs/bridge.log | sed 's/2026-/\n2026-/g' | grep -v 'memory-db.*Database initialized' | tail -50

# Memory DB last activity
ls -lt ~/.agentbridge/memory/audit/ | head -5
```

## Browser Agent

```bash
# Is the browser container running?
docker ps --filter name=agentbridge-browser --format "{{.ID}} {{.Status}}"

# What's running inside the container?
docker exec agentbridge-browser ps aux

# Container logs
docker logs agentbridge-browser --tail 30

# Take a screenshot of current browser state
agentbridge-browser --action screenshot --session-id browse | jq -r '.screenshot' | base64 -d > /tmp/browser.png

# Read what's on the page right now
agentbridge-browser --action extract_text --session-id browse

# List clickable/fillable elements
agentbridge-browser --action get_page_info --session-id browse

# Check pending browse tasks
cat ~/.agentbridge/memory/pending_browse.json 2>/dev/null || echo "no pending tasks"

# Check browse task logs
ls -lt ~/.agentbridge/logs/browse_*.log 2>/dev/null | head -5

# Kill a stuck browser session
agentbridge-browser --action close_session --session-id browse

# Nuclear: restart the container
~/.agentbridge/browser-docker.sh stop && ~/.agentbridge/browser-docker.sh
```

## Cron & Reminders

```bash
# Pending cron entries
cat ~/.agentbridge/memory/cron.json 2>/dev/null | jq '.[] | select(.fired == false)'

# Pending reminders waiting for delivery
cat ~/.agentbridge/memory/pending_reminders.json 2>/dev/null

# Todo list
agentbridge-todo list
```

## Memory System

```bash
# DB size and health
ls -lh ~/.agentbridge/memory/memory.db
sqlite3 ~/.agentbridge/memory/memory.db "SELECT COUNT(*) FROM messages; SELECT COUNT(*) FROM extracted_memories;"

# Latest sleep audit
ls -lt ~/.agentbridge/memory/audit/ | head -3
cat "$(ls -t ~/.agentbridge/memory/audit/sleep_*.md 2>/dev/null | head -1)" 2>/dev/null | head -30

# Working directories (pending consolidation)
ls ~/.agentbridge/memory/working/ 2>/dev/null
```

## Self-Healing Checks

Run these when things feel off or after a restart to catch problems early.

```bash
# Orphaned kiro-cli processes (no parent bridge) — should return NOTHING
# If any show up, they're zombies from crashed sessions. Kill them.
ps aux | grep 'kiro-cli.*acp' | grep -v grep | awk '{print $2, $9, $11}' | while read pid start cmd; do
  ppid=$(awk '/PPid/{print $2}' /proc/$pid/status 2>/dev/null)
  bridge=$(ps -p $ppid -o cmd= 2>/dev/null)
  [[ "$bridge" != *"dist/main.js"* ]] && echo "ORPHAN: pid=$pid started=$start ppid=$ppid"
done

# Sleep subagent still alive? Should exit within ~2 min of spawning.
ps aux | grep 'kiro-cli-chat acp' | grep -v grep | grep -v pts/ | awk '{print "DETACHED:", $2, "elapsed:", $10, $11, $12}'

# Pending browse tasks with dead pids (stuck deliveries)
cat ~/.agentbridge/memory/pending_browse.json 2>/dev/null | jq -r '.[] | "\(.pid) \(.taskId) \(.task)"' | while read pid tid task; do
  kill -0 $pid 2>/dev/null || echo "DEAD TASK: $tid (pid $pid) — $task"
done

# Pending reminders not being delivered (should be empty most of the time)
count=$(cat ~/.agentbridge/memory/pending_reminders.json 2>/dev/null | jq 'length')
[[ "$count" -gt 0 ]] && echo "WARNING: $count undelivered reminders" && cat ~/.agentbridge/memory/pending_reminders.json | jq -r '.[].message[:80]'

# DB lock check — should return instantly. If it hangs, something holds the lock.
timeout 3 sqlite3 ~/.agentbridge/memory/memory.db "SELECT COUNT(*) FROM messages;" && echo "DB OK" || echo "DB LOCKED"

# Disk budget
du -sh ~/.agentbridge/memory/ | awk '{print "Memory disk:", $1}'
```

## Transport (ACP)

```bash
# Active kiro-cli ACP sessions
ps aux | grep 'kiro-cli.*acp' | grep -v grep

# Orphaned kiro-cli processes (no parent bridge)
ps aux | grep 'kiro-cli-chat acp' | grep -v grep

# Kill orphaned sessions (careful!)
# pkill -f 'kiro-cli-chat acp --agent professor'
```

## Telegram

```bash
# Test bot connectivity
TOKEN=$(grep TELEGRAM_BOT_TOKEN ~/.agentbridge/.env | cut -d= -f2)
curl -s "https://api.telegram.org/bot${TOKEN}/getMe" | jq .ok
```
