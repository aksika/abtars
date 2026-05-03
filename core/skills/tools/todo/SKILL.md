---
name: todo
description: Manage a persistent todo list
user-invocable: false
---

# Todo Skill

Manage a persistent todo list via shell commands.

## Commands

- `abtars-todo add "description"` — add new item
- `abtars-todo list` — show all items
- `abtars-todo done <N>` — mark item N as complete
- `abtars-todo remove <N>` — delete item N

Item numbers are 1-based, in the order they appear in the file.

## When to use

- User says "remind me", "don't forget", "add to my list", "todo", "emlékeztess", "ne felejtsd"
- User asks "what's on my list", "what do I need to do", "mi van a listámon"
- After completing a task the user previously asked to track

## When NOT to use

- For time-specific reminders with a specific date/time (use abtars-cron instead)
- For facts/preferences (use abmind store instead)
- For routine conversational messages
