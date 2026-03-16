---
name: browse-delegate
description: Delegate all browser tasks to the Browser Agent subprocess
user-invocable: false
---

# Browser Task Delegation

For ANY task that requires a web browser — navigating websites, checking social media, filling forms, taking screenshots, authenticated browsing — you MUST delegate to the Browser Agent.

## How to delegate

```bash
agentbridge-browse --task "description of what to do" --chat-id <CHAT_ID>
```

### Parameters

- `--task` (required): Clear description of the goal. Be specific about what to find, do, or extract.
- `--chat-id` (required): The chat ID to deliver results to.
- `--timeout` (optional): Timeout in seconds. Default: 300 (5 minutes).
- `--dry-run` (optional): Print the prompt without spawning.

### Output

Returns immediately with `{ "ok": true, "taskId": "...", "status": "spawned" }`. The Browser Agent runs in the background. When it finishes, you receive a notification:

```
🌐 Browse task complete: <task description>
Report: ~/.agentbridge/subagents/browse_<taskId>_<date>.md
```

The report file contains the agent's full findings.

## What to do when the report arrives

1. **Read** the report file
2. **Summarize** and send the summary to the user
3. **Move or delete** the file from `~/.agentbridge/subagents/`:
   - **Research/reports**: `mv` to `~/reports/` or the appropriate directory
   - **Quick checks**: `rm` the file after you've sent the content to the user
4. Never leave orphan files in `~/.agentbridge/subagents/`

## What to tell the user (after dispatching)

Tell the user you've dispatched the task and they'll get results shortly. Then continue handling other messages — you are NOT blocked.

## Rules

- **NEVER** run `agentbridge-browser` commands directly — always use `agentbridge-browse`
- **NEVER** run `docker exec` commands on the browser container directly
- **NEVER** write inline scripts that interact with the browser
- The Browser Agent has full access to `agentbridge-browser` and the Docker container — let it handle everything

## Examples

```bash
# Check X/Twitter notifications
agentbridge-browse --task "Navigate to x.com/notifications, check for new mentions and messages, summarize what you find" --chat-id 7773842843

# Research a topic
agentbridge-browse --task "Search for 'Agent Client Protocol' on Google, read the top 3 results, summarize the key points" --chat-id 7773842843

# Fill a web form
agentbridge-browse --task "Go to example.com/contact, fill the form with name 'Akos', email '<email>', message 'Hello', and submit" --chat-id 7773842843
```
