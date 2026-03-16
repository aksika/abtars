---
name: cron
description: Schedule time-based reminders and tasks
user-invocable: false
---

# Cron Skill

Schedule time-based reminders and tasks via shell commands.

## Commands

- `agentbridge-cron add --at "YYYY-MM-DDTHH:MM" --message "..." --chat-id <ID> --type reminder|task`
- `agentbridge-cron list` — show pending entries
- `agentbridge-cron remove <id>` — cancel a scheduled entry

## Types

- `reminder`: fires as a message through the agent personality (injected into conversation)
- `task`: spawns a subagent to execute, sends plain report via Telegram

## When to use

- User says "remind me at 3pm", "Sunday at 2am do X", specific time references
- User asks to schedule a recurring check or action
- User mentions a specific date/time for a future action

## When NOT to use

- For vague "remind me later/tomorrow" without specific time (use agentbridge-todo)
- For immediate actions (just do them now)
- For facts/preferences (use agentbridge-store instead)
