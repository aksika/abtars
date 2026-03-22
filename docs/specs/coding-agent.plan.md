# /coding Command — Implementation Plan

**Status:** Planning complete, ready to implement
**Backlog:** #19

## Overview

`/coding` switches the Telegram session to a dedicated Opus coding agent. `/default` switches back to KP. The coding agent runs in its own kiro-cli ACP process with thinking enabled.

## Commands

| Command | Platforms | Behavior |
|---------|-----------|----------|
| `/coding` | Telegram only | Switch to Opus coding agent, spawn separate AcpTransport |
| `/default` | Telegram + Discord | Switch back to KP main agent, kill coding transport |
| `/reset` | both | Always resets back to KP main agent (kills coding if active) |
| `/new` | both | Resets session but keeps current agent mode |

## Architecture

```
User sends /coding
  → spawn kiro-cli acp --agent coding-agent --model claude-opus-4.6
  → inject facts message (project root, docs location)
  → coding agent sends welcome message
  → all subsequent messages route to coding transport

User sends /default
  → coding transport runs: git checkout main
  → kill coding transport
  → resume routing to KP main transport
```

## State

Per-chat:
- `activeMode: "default" | "coding"` — determines message routing
- `codingTransport: AcpTransport | null` — lazy-spawned, killed on /default or /reset

## Config

- `CODING_AGENT_MODEL` env var (already added: `claude-opus-4.6`)
- `codingAgentModel` field in config.ts

## Kiro Settings

- `chat.enableThinking = true` — already set globally, coding agent inherits it

## Files to Change

1. `src/components/config.ts` — add `codingAgentModel` field
2. `src/main.ts` — per-chat mode map, `/coding` handler (TG only), `/default` handler (TG + Discord), modify `/reset` to force default mode, modify message routing to check active mode
3. `skills/agents/CODING.md` — already created (git workflow, WSL boundary, docs, TS conventions, security)

## Injected Facts (first message to coding agent)

```
[SYSTEM] You are the coding agent for AgentBridge.
Project root: /home/qakosal/workspace/agentbridge
Read docs/specs/system.asbuilt.md and docs/specs/memory.asbuilt.md before making changes.
Always create a new git branch before coding. Switch back to main when done.
```

## Security

- `/coding` is Telegram-only (hard gate — handler not wired in Discord)
- KP (main agent) is forbidden from modifying source code (trust-gating.md)
- Coding agent is WSL-only, workspace paths only (CODING.md)

## Edge Cases

- `/default` with uncommitted changes: warn but switch anyway (user's responsibility)
- Bridge restart: mode resets to default, coding transport is null
- `/coding` while already in coding mode: no-op, inform user
- `/default` while already in default mode: no-op, inform user

## NOT in scope

- Reasoning budget control (kiro-cli only has on/off, no levels)
- Persistent coding sessions across bridge restarts
- Discord access to coding mode
