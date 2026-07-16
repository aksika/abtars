# Task Management

Create, edit, and manage scheduled tasks. Tasks live at `~/.abtars/tasks/` — each task is a directory.

## Structure

```
~/.abtars/tasks/
├── tasks.json              # Registry: schedule, kind, taskFile path (definitions only)
├── task-state.json          # Runtime state (auto-managed, do not edit)
├── task-history.jsonl       # Append-only run log (auto-managed)
├── my-task/
│   ├── TASK.md              # Main prompt (what the agent does)
│   ├── feeds.json           # Associated data (auto-injected)
│   └── report-template.md   # Any supporting files
```

All files in a task directory (except TASK.md) are automatically injected as context when the task runs.

## Creating a task

1. Create the directory and TASK.md:
```bash
mkdir -p ~/.abtars/tasks/my-task
cat > ~/.abtars/tasks/my-task/TASK.md << 'EOF'
# My Task

Instructions for what the agent should do when this task fires.
Use {today} for today's date (auto-substituted).
EOF
```

2. Register in tasks.json via CLI:
```bash
abtars-task add \
  --id my-task \
  --schedule "0 9 * * *" \
  --message "Run my-task" \
  --kind agent \
  --task-file "~/.abtars/tasks/my-task/TASK.md" \
  --chat-id <CHAT_ID>
```

## Schedule format

Standard cron: `minute hour day month weekday`

| Example | Meaning |
|---------|---------|
| `0 9 * * *` | Daily at 9am |
| `30 8 * * 1-5` | Weekdays at 8:30am |
| `0 0 * * *` | Midnight daily |
| `0 */6 * * *` | Every 6 hours |

For one-shot tasks, use `--at "2026-12-25T08:00"` instead of `--schedule`.

## Task kinds

| Kind | Behavior |
|------|----------|
| `agent` | Agent session runs the prompt or TASK.md |
| `script` | Shell command runs directly |
| `reminder` | Simple text reminder at scheduled time |
| `orc` | Orc project dispatch |
| `system` | Internal bridge action (sleep-cycle, hardware-sleep) |

## Delivery modes

Set `delivery` in tasks.json. Each kind has a required delivery mode.

| Mode | Behavior | Use for |
|------|----------|---------|
| `report` | Drop the result file to chat (no model call) | Reports, generated documents |
| `announce` | Send the agent's response text directly | Greetings, conversational tasks |
| `silent` | No output to user | Internal housekeeping, scripts |

Example:

```json
{
  "id": "finance-report",
  "kind": "agent",
  "delivery": "report",
  "schedule": "30 9 * * *",
  "prompt": "Run the finance report",
  "chatId": "7773842843",
  "enabled": true
}
```

## Managing tasks

```bash
abtars-task list                # Show all tasks
abtars-task remove <id>         # Delete a task
abtars-task pause <id>          # Pause a task
abtars-task resume <id>         # Resume a paused task
abtars-task history <id>        # Show run history
```

Or via Telegram: `/tasks` (list), `/task run <id>` (trigger), `/task pause <id>`, `/task resume <id>`.

## Tips

- Keep TASK.md focused — one clear instruction per task
- Put data files (feeds, watchlists, templates) as siblings — they auto-inject
- Use `schedule` for recurring tasks and `at` for one-shots
- The DoD section in TASK.md must contain absolute paths only (one per bullet)
