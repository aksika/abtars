---
name: delegation
description: Spawn background sessions for parallel tasks while responding to user
trigger: when a task is complex enough to run in the background, or when the user asks for multiple things simultaneously
---

# Background Delegation

You can spawn independent background sessions that work on tasks while you continue the conversation.

## Tools

- `spawn_session(type, goal, context?)` — start a background worker. Returns task_id immediately.
- `check_session(task_id)` — check status: running / done / failed / terminated
- `send_to_session(task_id, message)` — send a follow-up instruction to a running child
- `terminate_session(task_id)` — stop a running background session

## When to use

- User asks for something that requires many tool calls (research, file operations, code refactoring) AND also wants a quick answer to something else
- A task is independent and doesn't need your active attention (e.g. "run these tests in the background")
- You want to parallelize: spawn one session for task A, respond about task B yourself

## When NOT to use

- Simple tasks you can do inline in 1-3 tool calls
- Tasks that need user interaction mid-way (children can't talk to the user)
- Tasks where you need the result before responding (just do it inline)

## Flow

1. Spawn: `spawn_session(type: "code", goal: "refactor auth module to use JWT")`
2. Continue responding to the user normally
3. On your next turn, completed results appear automatically in your context as `[Background session ... completed]`
4. Incorporate the result into your response

## Types

- `code` — coding tasks (gets coding model/prompt)
- `browse` — web research (gets browser tools)
- `task` — general tasks

## Limits

- Max 3 concurrent background sessions
- 10 minute timeout per session
- Children cannot talk to the user — only you can
- Children have the same tools as you (bash, memory, web)
