---
name: cron
description: Schedule time-based reminders and tasks
user-invocable: false
---

# Cron

Schedule reminders and tasks via `agentbridge-cron`. Never use host crontab.

## One-shot
```bash
agentbridge-cron add --at "YYYY-MM-DDTHH:MM" --message "..." --chat-id <ID> --type reminder
agentbridge-cron add --at "YYYY-MM-DDTHH:MM" --message "..." --chat-id <ID> --type task --executor agent
```

## Recurring
```bash
agentbridge-cron add --schedule "30 7 * * *" --message "command or prompt" --chat-id <ID> --type task --executor script
agentbridge-cron add --schedule "0 10 * * *" --message "Follow the research prompt..." --chat-id <ID> --type task --executor agent
```

Schedule format: `min hour dom month dow` (standard cron).

## Management
```bash
agentbridge-cron list              # show pending/recurring
agentbridge-cron remove <id>       # cancel by 6-char hex ID
agentbridge-cron pause <id>        # temporarily disable
agentbridge-cron resume <id>       # re-enable
agentbridge-cron history <id>      # last 10 runs
```

## How it fires
Bridge heartbeat checks every 5 min. When due:
- `reminder` → injected as message through agent personality
- `task` + `executor: agent` → spawns kiro-cli subagent, reports via Telegram
- `task` + `executor: script` → runs `bash -c`, reports exit code + output

## Running tasks manually

When the user asks to run a scheduled task (e.g. "run the finance report", "trigger the AI daily"):
1. Use `task_manage` with `action: "run"` and the task `id`
2. **Never execute the task content inline** — always delegate via `task_manage --run`
3. The task runs in an isolated subagent with the full task file prompt
4. Result is sent to the user's chat when complete

## When to use
- Specific time: `--at` + `--type reminder` or `--type task`
- Recurring: `--schedule` + appropriate executor
- No specific time ("remind me later"): use `agentbridge-todo` instead
