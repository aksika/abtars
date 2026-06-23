# Task Management

Create, edit, and manage scheduled tasks. Tasks live at `~/.abtars/tasks/` — each task is a directory.

## Structure

```
~/.abtars/tasks/
├── tasks.json              # Registry: schedule, executor, taskFile path
├── my-task/
│   ├── TASK.md             # Main prompt (what the agent does)
│   ├── feeds.json          # Associated data (auto-injected)
│   └── report-template.md  # Any supporting files
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
  --title "My Task" \
  --schedule "0 9 * * *" \
  --message "Run my-task" \
  --type task \
  --executor agent \
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

## Executor types

| Type | Behavior |
|------|----------|
| `agent` | Agent session runs the TASK.md prompt |
| `script` | Shell command in `message` field runs directly |

## Managing tasks

```bash
abtars-task list                    # Show all tasks
abtars-task remove --id my-task     # Delete a task
abtars-task run --id my-task        # Manual trigger
```

Or via Telegram: `/tasks` (list), `/task run <id>` (trigger), `/task pause <id>`, `/task resume <id>`.

## Tips

- Keep TASK.md focused — one clear instruction per task
- Put data files (feeds, watchlists, templates) as siblings — they auto-inject
- Use `--max-runs-per-day 1` to prevent re-firing on restart
- Script tasks with `agentFollowUp: true` + `agentMessage` field → agent processes the script output
