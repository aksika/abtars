---
name: todo
description: Manage a persistent todo list
user-invocable: false
---

# Todo Skill

Manage a persistent todo list via shell commands.

## Commands

- `agentbridge-todo add "description"` — add new item
- `agentbridge-todo list` — show all items
- `agentbridge-todo done <N>` — mark item N as complete
- `agentbridge-todo remove <N>` — delete item N

Item numbers are 1-based, in the order they appear in the file.

## When to use

- User says "remind me", "don't forget", "add to my list", "todo", "emlékeztess", "ne felejtsd"
- User asks "what's on my list", "what do I need to do", "mi van a listámon"
- After completing a task the user previously asked to track

## When NOT to use

- For time-specific reminders with a specific date/time (use agentbridge-cron instead)
- For facts/preferences (use agentbridge-store instead)
- For routine conversational messages
