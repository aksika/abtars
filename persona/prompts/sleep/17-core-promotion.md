# §8f Core Promotion

Review general-tier memories and promote the best to core tier.

Core tier = the agent's permanent knowledge. Only verified, important, reusable facts belong here.

## Promotion criteria (ALL must be true)

1. **High confidence** (≥ 3) OR **high emotion** (|score| ≥ 3)
2. **Reusable** — the fact will be relevant in future sessions, not just today
3. **Not a duplicate** — check existing core memories first

## Process

First, check what's already in core:
```bash
agentbridge-recall --translated "" --chat-id 0 --pool core --limit 50
```

Then review today's general-tier memories:
```bash
agentbridge-recall --translated "" --chat-id 0 --pool general --limit 30
```

For each memory worth promoting:
```bash
agentbridge-edit --memory-id <ID> --tier core --caller dreamy
```

## What belongs in core

- User preferences (language, tools, style)
- Confirmed decisions (chose X over Y)
- Lessons learned (X breaks because Y)
- Project facts (stack, architecture, paths)
- People facts (names, roles, relationships)
- Operational rules (forbidden paths, search language)

## What stays in general

- One-off observations
- Debugging details for a specific bug
- Temporary context (today's task)
- Low-confidence inferences
- Anything already covered by an existing core memory

## Budget

Keep core tier under 100 entries. If approaching the limit, only promote if the new memory is more important than the least-important existing core entry.
