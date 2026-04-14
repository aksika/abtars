---
name: browse-delegate
description: Delegate complex browser tasks to the Browsie agent (Level 2 browsing)
user-invocable: false
---

# Browser Task Delegation (Level 2)

For complex browser tasks requiring JavaScript, login, anti-bot bypass, or multi-page navigation.

**Try Level 1 first:** `agentbridge-fetch "<url>"` — fast, no spawn. Only escalate here if Level 1 fails or the task requires a full browser.

```bash
agentbridge-browse --task "description" --chat-id <CHAT_ID> [--thread-id <THREAD_ID>] [--timeout 300]
```

Returns immediately. Browsie agent runs in background. Results delivered to chat when done.

## When report arrives
1. Read report from `~/.agentbridge/subagents/browse_<taskId>_<date>.md`
2. Summarize and send to user
3. Move to `~/.agentbridge/reports/` (research) or delete (quick checks)

## Rules
- **NEVER** run `agentbridge-browser` directly — always use `agentbridge-browse`
- **NEVER** run `docker exec` on the browser container
- Tell user you've dispatched the task, then continue handling other messages
