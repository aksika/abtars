# Todo System

A persistent, file-based todo list the agent manages autonomously. Detects "remind me" / "don't forget" patterns and stores items without you needing to use commands.

## How it works

Just say things like:
- "Don't forget to export the session cookies"
- "Add to my list: investigate the daily report"
- "What's on my todo?"

The agent detects the intent, runs the CLI, and confirms.

## Storage

Plain markdown at `~/.abtars/memory/todo.md`:

```markdown
# Todo List

- [ ] 2026-03-15: Export X/Twitter session cookies
- [ ] 2026-03-15: Investigate daily report not functioning
- [x] 2026-03-14: Fix browser socket permissions
```

## When todo vs other systems

| Pattern | Goes to |
|---------|---------|
| "Remind me to X" (no time) | Todo |
| "Remind me at 3pm to X" | Scheduled task (cron) |
| "I prefer dark mode" | Memory (instant-store) |
| "Every Monday check Y" | Scheduled task (cron) |

## CLI reference

```bash
abtars-todo add "description"    # Append item with today's date
abtars-todo list                 # Print all items
abtars-todo done <N>             # Mark item N as complete (1-based)
abtars-todo remove <N>           # Delete item N entirely
```

Output is JSON — the agent parses it and responds naturally.
