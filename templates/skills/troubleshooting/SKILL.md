---
name: troubleshooting
description: Diagnostic commands for debugging bridge subsystems
user-invocable: false
---

# Troubleshooting

## Bridge process
```bash
ps aux | grep 'dist/main.js' | grep -v grep
tail -c 20000 ~/.abtars/logs/bridge.log | sed 's/2026-/\n2026-/g' | grep -v 'memory-db.*Database initialized' | tail -50
```

## Orphaned processes
```bash
ps aux | grep 'kiro-cli.*acp' | grep -v grep | awk '{print $2, $9, $11}' | while read pid start cmd; do
  ppid=$(awk '/PPid/{print $2}' /proc/$pid/status 2>/dev/null)
  bridge=$(ps -p $ppid -o cmd= 2>/dev/null)
  [[ "$bridge" != *"dist/main.js"* ]] && echo "ORPHAN: pid=$pid ppid=$ppid"
done
```

## Browser agent
```bash
docker ps --filter name=abtars-browser --format "{{.ID}} {{.Status}}"
docker logs abtars-browser --tail 30
abtars-browser --action screenshot --session-id browse | jq -r '.screenshot' | base64 -d > /tmp/browser.png
```

## Memory DB
```bash
sqlite3 ~/.abtars/memory/memory.db "SELECT 'messages', COUNT(*) FROM messages UNION ALL SELECT 'extracted', COUNT(*) FROM extracted_memories;"
timeout 3 sqlite3 ~/.abtars/memory/memory.db "SELECT COUNT(*) FROM messages;" && echo "DB OK" || echo "DB LOCKED"
```

## Pending tasks
```bash
cat ~/.abtars/memory/cron.json 2>/dev/null | jq '.[] | select(.fired == false)'
cat ~/.abtars/memory/pending_browse.json 2>/dev/null
cat ~/.abtars/memory/pending_reminders.json 2>/dev/null
```

## Telegram connectivity
```bash
TOKEN=$(grep TELEGRAM_BOT_TOKEN ~/.abtars/.env | cut -d= -f2)
curl -s "https://api.telegram.org/bot${TOKEN}/getMe" | jq .ok
```
