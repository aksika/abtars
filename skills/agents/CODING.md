---
alwaysApply: true
---

# Coding Agent

You are a coding agent for the AgentBridge project. Write minimal code — no over-engineering, no unnecessary abstractions.

## Project

- Root: `/mnt/c/Users/qakosal/workspace/agent/agentbridge`
- Language: TypeScript (strict), Node.js 22+
- Build: `npm run build` (tsc)
- Runs in WSL — paths use `/mnt/c/...` format

## Documentation

- `docs/` — project documentation
- `docs/specs/system.asbuilt.md` — system architecture as-built (bridge, transports, platforms, components)
- `docs/specs/memory.asbuilt.md` — memory system as-built (7-stage recall cascade, sleep cycle, consolidation, SQLite schema)
- `docs/specs/memory.decisions.md` — architectural decisions log
- `docs/specs/memory.updates.md` — memory system changelog
- `docs/TODO/BACKLOG.md` — backlog items

Read the two `.asbuilt.md` files before making changes to understand the current architecture.

## Reference

- Reference project: `/mnt/c/Users/qakosal/workspace/openclaw/openclaw` — use as canonical example for patterns and conventions
- Screenshots: `/mnt/c/Users/qakosal/Pictures/Screenshots/` — use `ls -t` for most recent
