---
name: task
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

## Skill-trigger tasks

A task can trigger a named skill by setting the `skill` field in tasks.json:

```json
{
  "id": "finance-report",
  "skill": "finance",
  "message": "Run the daily report",
  "executor": "agent",
  "schedule": "30 9 * * *"
}
```

The skill must have a `skill.json` in its directory to be launchable. When fired, the task-queue launches the skill in a dedicated session with the skill's SKILL.md + CONTEXT.md.

## Persistent task context (CONTEXT.md)

Tasks can maintain persistent notes across runs via `~/.abtars/workspace/<task-id>/CONTEXT.md`. If this file exists, its content is automatically prepended to the task prompt on every run.

At the end of a task run, update this file with notes for your next run: what was covered, what to do next. Keep it concise.

## Skill-managed context (for skills with user-scoped progress)

Skills that serve multiple users (tutoring, coaching) maintain per-user context:

```
~/.abtars/workspace/<skill-name>/<userId>/CONTEXT.md
```

The SKILL.md should instruct:
1. Read your context file at the start of each session
2. Update it at the end with progress notes
3. Create the directory on first run if it doesn't exist

This convention works for both task-triggered and manually invoked skill sessions (`/skill run <name>`).
