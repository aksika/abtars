---
name: cron
description: Schedule time-based reminders and tasks
user-invocable: false
---

# Cron Skill

Schedule time-based reminders and tasks. Two scheduling methods available depending on recurrence.

## Method 1: Host Crontab (recurring/daily tasks)

Use real system crontab for anything that runs on a fixed schedule (daily, hourly, weekly).

```bash
# Add a recurring task (MUST include # agentbridge-managed tag for catch-up)
(crontab -l 2>/dev/null; echo '0 8 * * * /home/qakosal/.local/bin/agentbridge-browse --task "description" --chat-id <ID> --timeout 600 # agentbridge-managed') | crontab -

# List scheduled tasks
crontab -l

# Remove a specific task (by grep pattern)
crontab -l | grep -v 'pattern-to-remove' | crontab -
```

The 5-min heartbeat checker in the bridge picks up Brownie results from `pending_browse.json` and delivers them to the chat automatically.

### Intelligent catch-up
Entries tagged `# agentbridge-managed` are tracked. If the bridge was down when a job should have fired, it catches up automatically on next startup. The tag is REQUIRED for this to work — always include it.

### Crontab format
```
┌───────── minute (0-59)
│ ┌─────── hour (0-23)
│ │ ┌───── day of month (1-31)
│ │ │ ┌─── month (1-12)
│ │ │ │ ┌─ day of week (0-6, Sun=0)
│ │ │ │ │
* * * * * command
```

### Verify it's scheduled
```bash
crontab -l | grep 'keyword'
```

## Method 2: Internal Cron (one-off reminders/tasks)

Use `agentbridge-cron` for one-time future events — reminders or single tasks at a specific date/time.

```bash
# Schedule a one-off
agentbridge-cron add --at "YYYY-MM-DDTHH:MM" --message "..." --chat-id <ID> --type reminder|task

# List pending
agentbridge-cron list

# Cancel
agentbridge-cron remove <id>
```

The bridge heartbeat checks `cron.json` every 5 minutes. When `fireAt` is past:
- `reminder` → injected into conversation via pending_reminders.json
- `task` → spawns a subagent to execute, sends report via Telegram

### Verify the heartbeat picks it up
```bash
# Confirm entry exists and is not yet fired
cat ~/.agentbridge/memory/cron.json | jq '.[] | select(.fired == false) | {id, fireAt: (.fireAt/1000 | todate), message: .message[:80], type}'

# After fire time, check it was delivered
cat ~/.agentbridge/memory/pending_reminders.json | jq .
cat ~/.agentbridge/memory/cron.json | jq '.[] | select(.fired == true) | {id, type}'
```

## Types

- `reminder`: fires as a message through the agent personality (injected into conversation)
- `task`: spawns a subagent to execute, sends plain report via Telegram

## When to use which

| Scenario | Method |
|----------|--------|
| Daily/weekly/hourly recurring task | Host crontab |
| "Every day at 8am scan AI news" | Host crontab + agentbridge-browse |
| "Remind me at 3pm today" | agentbridge-cron (one-off reminder) |
| "Run this task next Tuesday at noon" | agentbridge-cron (one-off task) |
| "Remind me later" (no specific time) | agentbridge-todo (not cron) |
