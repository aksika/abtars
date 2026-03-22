---
name: browse-delegate
description: Delegate all browser tasks to the Browser Agent subprocess
user-invocable: false
---

# Browser Task Delegation

For ANY browser task — navigating, scraping, forms, screenshots, authenticated browsing — delegate to the Browser Agent.

```bash
agentbridge-browse --task "description" --chat-id <CHAT_ID> [--thread-id <THREAD_ID>] [--timeout 300]
```

Returns immediately: `{ "ok": true, "taskId": "...", "status": "spawned" }`. Agent runs in background.

## When report arrives
1. Read report from `~/.agentbridge/subagents/browse_<taskId>_<date>.md`
2. Summarize and send to user
3. Move to `~/reports/` (research) or delete (quick checks). Never leave orphans.

## Rules
- **NEVER** run `agentbridge-browser` directly — always use `agentbridge-browse`
- **NEVER** run `docker exec` on the browser container
- Tell user you've dispatched the task, then continue handling other messages (non-blocking)
