---
name: cron
description: Schedule time-based reminders and tasks
user-invocable: false
---

# Cron Skill

Schedule time-based reminders and tasks. All scheduling goes through the internal `agentbridge-cron` CLI — never use host crontab.

## One-shot (specific date/time)

```bash
agentbridge-cron add --at "YYYY-MM-DDTHH:MM" --message "..." --chat-id <ID> --type reminder
agentbridge-cron add --at "YYYY-MM-DDTHH:MM" --message "..." --chat-id <ID> --type task --executor agent
```

## Recurring (cron schedule)

```bash
# Dumb script — runs bash directly, no agent
agentbridge-cron add --schedule "30 7 * * *" --message "~/.agentbridge/scripts/daily-backup.sh" --chat-id <ID> --type task --executor script

# Intelligent task — spawns kiro-cli agent
agentbridge-cron add --schedule "0 10 * * *" --message "Follow the research prompt..." --chat-id <ID> --type task --executor agent
```

### Cron schedule format
```
┌───────── minute (0-59)
│ ┌─────── hour (0-23)
│ │ ┌───── day of month (1-31)
│ │ │ ┌─── month (1-12)
│ │ │ │ ┌─ day of week (0-6, Sun=0)
│ │ │ │ │
* * * * * 
```

## Management

```bash
agentbridge-cron list              # Show pending/recurring entries
agentbridge-cron remove <id>       # Cancel entry by 6-char hex ID
```

## How it fires

The bridge heartbeat checks `cron.json` every 5 minutes. When `fireAt` is past:
- `reminder` → injected into conversation as a synthetic message
- `task` + `executor: agent` → spawns kiro-cli subagent, sends report via Telegram
- `task` + `executor: script` → runs `bash -c` directly, reports exit code + output

Recurring entries automatically reschedule to the next fire time after each execution.

## Types

- `reminder`: fires as a message through the agent personality
- `task`: executes work — either via agent (intelligent) or script (dumb)

## Executor

- `agent` (default): spawns kiro-cli — use for tasks requiring intelligence
- `script`: runs bash command directly — use for existing scripts/CLIs

## When to use which

| Scenario | Flags |
|----------|-------|
| "Remind me at 3pm today" | `--at ... --type reminder` |
| "Run this task next Tuesday" | `--at ... --type task` |
| "Every day at 7:30am run backup" | `--schedule "30 7 * * *" --type task --executor script` |
| "Every day at 10am scan AI news" | `--schedule "0 10 * * *" --type task --executor agent` |
| "Remind me later" (no specific time) | Use `agentbridge-todo`, not cron |

## Verify

```bash
cat ~/.agentbridge/memory/cron.json | jq '.[] | select(.fired == false or .schedule) | {id, fireAt: (.fireAt/1000 | todate), message: .message[:80], type, executor, schedule}'
```
