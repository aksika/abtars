# Scheduled Tasks

abTARS runs scheduled tasks via a built-in task system. No crontab needed — the agent manages everything.

## Creating tasks via chat

Just ask the agent in natural language:

| You say | What happens |
|---------|-------------|
| "Remind me every morning at 9 to check emails" | Creates a recurring reminder at 09:00 daily |
| "Every Friday at 5pm, summarize my week" | Creates a recurring agent task — runs autonomously and sends you the result |
| "Remind me tomorrow at 3pm about the dentist" | Creates a one-shot reminder |
| "Run a backup every night at 3am" | Creates a recurring script task |

The agent reads the task skill, picks the right command, and confirms what it created. You don't need to know any CLI syntax.

## How it works

The bridge heartbeat checks every 5 minutes for due tasks. When one fires:

| Type | Behavior |
|------|----------|
| **reminder** | Sends the message to you through the agent's personality |
| **task** (executor: agent) | Spawns a subagent that works on the prompt, sends result when done |
| **task** (executor: script) | Runs a shell command, reports exit code + output |

## Managing tasks in chat

| Command | Description |
|---------|-------------|
| `/tasks` | List all tasks with today's status |
| `/tasks trigger <id>` | Run a task immediately |
| `/tasks log <id>` | Show last 5 runs |

Or just ask: "show my scheduled tasks", "cancel the morning reminder", "pause the backup task".

## Example: "Every Friday at 5pm, summarize my week"

1. Agent reads the task skill, picks the right command
2. Runs: `abtars-task add --schedule "0 17 * * 5" --message "Summarize what happened this week" --chat-id <your-ID> --type task --executor agent`
3. Confirms: "Done — every Friday at 17:00 I'll summarize your week."

Every Friday at 5pm, the bridge fires the task, the agent works on it autonomously, and sends you the result on Telegram.

## CLI reference

For direct management (or scripting):

```bash
# One-shot reminder
abtars-task add --at "2026-06-01T15:00" --message "Dentist appointment" --chat-id <ID> --type reminder

# Recurring task (agent executes)
abtars-task add --schedule "0 17 * * 5" --message "Summarize my week" --chat-id <ID> --type task --executor agent

# Recurring task (script executes)
abtars-task add --schedule "0 3 * * *" --message "abmind backup" --chat-id <ID> --type task --executor script

# Management
abtars-task list
abtars-task remove <id>
abtars-task pause <id>
abtars-task resume <id>
abtars-task history <id>
```

## Schedule format

Standard cron: `minute hour day month weekday`

```
0 9 * * *      → every day at 09:00
0 */4 * * *    → every 4 hours
30 22 * * 1-5  → weekdays at 22:30
0 17 * * 5     → Fridays at 17:00
```

## Status indicators

```
✓  ran successfully today
✗  failed today
~  currently running
+  scheduled, not yet run
—  not scheduled for today
```
