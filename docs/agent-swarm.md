# Agent Swarm — Background Delegation

## What it is

The main agent (KP/Molty) can spawn independent background sessions that work on tasks asynchronously. The user keeps chatting normally while background workers handle complex tasks in parallel.

## How it works

1. Model decides a task should run in the background
2. Calls `spawn_session(type: "code", goal: "refactor auth module")`
3. A background worker starts with its own conversation context and tools
4. Model responds to the user immediately — no blocking
5. When the worker finishes, the result appears in the model's context on the next turn
6. Model incorporates the result into its response

## Tools available to the model

| Tool | Purpose |
|------|---------|
| `spawn_session(type, goal, context?)` | Start a background worker. Returns task_id. |
| `check_session(task_id)` | Check status: running / done / failed / terminated |
| `send_to_session(task_id, message)` | Send follow-up instruction to a running child |
| `terminate_session(task_id)` | Stop a running background session |

## Session types

- **code** — coding tasks (uses coding model/prompt)
- **browse** — web research (uses browser tools)
- **task** — general tasks

## Lineage

Every spawned session has a `motherId` pointing to the session that created it. Visible in `/session` list as `← #1`.

## Pause / Resume

Users can pause any session:
- `/session pause [#]` — cooperative interrupt (finishes current tool call, then stops)
- `/session resume [#]` — continues from where it left off

## Limits

- Max 3 concurrent background sessions
- 10 minute timeout per session
- Children cannot interact with the user directly
- No nested delegation (depth = 1)

## Activation

Set `ENABLE_ASYNC_DELEGATION=true` in `~/.abtars/.env`. Without it, the tools are not registered and the feature is invisible.

## Auto-notify

When a background session completes, the result is automatically injected into the parent's context on the next user message:

```
[Background session 1747563282_C_03 done]
Goal: refactor auth module to use JWT
Result: Refactored auth.ts, middleware.ts, types.ts. All tests pass.
```

The model sees this and can tell the user about it naturally.

## Architecture diagram

```
┌─────────────────────────────────────────────┐
│  Main Agent (session A_01)                  │
│                                             │
│  ┌─ spawn_session("code", "refactor") ──┐  │
│  │                                       │  │
│  │  Background Worker (C_03)             │  │
│  │  - Own ConversationSession            │  │
│  │  - Own tool loop                      │  │
│  │  - motherId: A_01                     │  │
│  │  - Writes to CompletionBuffer on done │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  CompletionBuffer ──→ auto-notify on next   │
│                       user message          │
└─────────────────────────────────────────────┘
```

## Related tickets

- #510 — Session management (foundation)
- #539 — Interrupt + active registry
- #570 — Async delegation tools (the feature)
- #576 — Parent→child instruction injection
- #526 — File-based observable messaging (future upgrade)
- epic08 — Coordination epic
