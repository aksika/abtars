---
name: cron
description: Schedule time-based reminders and tasks
user-invocable: false
---

# Scheduled Tasks

Schedule reminders and tasks via `abtars-task`. Never use host crontab.

## One-shot
```bash
abtars-task add --at "YYYY-MM-DDTHH:MM" --message "..." --chat-id <ID> --type reminder
abtars-task add --at "YYYY-MM-DDTHH:MM" --message "..." --chat-id <ID> --type task --executor agent
```

## Recurring
```bash
abtars-task add --schedule "30 7 * * *" --message "command or prompt" --chat-id <ID> --type task --executor script
abtars-task add --schedule "0 10 * * *" --message "Follow the research prompt..." --chat-id <ID> --type task --executor agent
```

Schedule format: `min hour dom month dow` (standard cron).

## Management
```bash
abtars-task list              # show pending/recurring
abtars-task remove <id>       # cancel by 6-char hex ID
abtars-task pause <id>        # temporarily disable
abtars-task resume <id>       # re-enable
abtars-task history <id>      # last 10 runs
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
- No specific time ("remind me later"): use `abtars-todo` instead

## Task files convention

Complex tasks (scripts, data feeds, prompts) get a **directory** at `~/.abtars/tasks/<task-id>/`:

```
tasks/<task-id>/
├── TASK.md              # instructions/prompt (agent reads this)
├── run.sh               # entry script (if executor=script)
├── feeds.json           # data files
└── ...                  # any supporting files
```

When creating a task that needs supporting files:
1. `mkdir -p ~/.abtars/tasks/<task-id>/`
2. Write `TASK.md` with the full prompt/instructions
3. Write any scripts/data files alongside it
4. Register in tasks.json with `abtars-task add --message "Run the <task>"` — the message tells the agent what to do; TASK.md provides the detailed instructions

Never put task files loose at the `tasks/` root. One directory per task.
