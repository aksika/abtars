# #135 Formalize User Memory vs Project Memory Separation

**Date:** 2026-04-14
**Status:** Planned
**Priority:** LOW
**Depends on:** #131 (done)
**Feeds into:** #67 (multi-user), #137 (standalone kiro-cli)

## Goal

Formalize memory types with scope (private vs shared). User-specific memories stay private per userId. Project knowledge is shared across users.

## Current state

7 types defined, 4 used in production:
- `fact` (54), `decision` (24), `event` (17), `preference` (5)
- No scope concept — everything is flat, separated only by chatId

## Proposed type system

```typescript
type MemoryType = "user" | "feedback" | "project" | "reference";
type MemoryScope = "private" | "shared";

const DEFAULT_SCOPE: Record<MemoryType, MemoryScope> = {
  user: "private",       // role, preferences, expertise — always private
  feedback: "private",   // corrections, confirmations — private unless project-wide
  project: "shared",     // facts, decisions, events, goals — shared
  reference: "shared",   // pointers to external systems — shared
};
```

## Type definitions (inspired by Claude Code)

### user (always private)
Information about the user's role, goals, preferences, expertise. Helps tailor behavior per person.
- "User is a senior engineer, prefers concise responses"
- "User is learning Spanish, frame examples bilingually"

### feedback (default private)
Corrections and confirmations on approach. What to avoid, what to keep doing.
- "Don't mock the database in tests — prior incident"
- "Single bundled PR was the right call for refactors"
Override to shared when it's a project-wide convention.

### project (shared)
Facts, decisions, events, ongoing work. Not derivable from code/git.
- "Merge freeze begins 2026-03-05 for mobile release"
- "Auth rewrite driven by legal compliance, not tech debt"

### reference (shared)
Pointers to external systems and resources.
- "Pipeline bugs tracked in Linear project INGEST"
- "Oncall latency dashboard at grafana.internal/d/api-latency"

## Migration from current types

| Current | New | Scope |
|---|---|---|
| `preference` | `user` | private |
| `feedback` | `feedback` | private |
| `fact` | `project` | shared |
| `decision` | `project` | shared |
| `event` | `project` | shared |
| `lesson` | `feedback` | private |
| `story` | `project` | shared |

## Schema change

```sql
ALTER TABLE extracted_memories ADD COLUMN scope TEXT DEFAULT 'shared';
ALTER TABLE extracted_memories ADD COLUMN user_id TEXT;
```

Backfill: map existing `memory_type` to new type + scope using migration table above.

## Recall with scope

```sql
-- Multi-user: show shared + own private
WHERE (scope = 'shared' OR user_id = ?)

-- Single user (kiro-cli, current AB): no filter needed
```

## What this enables

| Context | Behavior |
|---|---|
| Single user (current AB, kiro-cli) | All memories visible, scope is metadata only |
| Multi-user AB (#67) | Master's preferences don't leak to friends, project facts shared |
| OC multi-agent | Each agent's user memories isolated, project knowledge shared |

## Store behavior

When storing, the agent decides type based on content:
- User talks about themselves → `user` (auto-private)
- User corrects approach → `feedback` (auto-private)
- User shares a fact/decision → `project` (auto-shared)
- User mentions external system → `reference` (auto-shared)

The sleep prompts and store tool need updated guidance for the new types.

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | Add `scope` + `user_id` columns to schema | 15 min |
| 2 | Backfill migration: map old types to new | 30 min |
| 3 | Update `MemoryType` in mem-types.ts | 15 min |
| 4 | Update recall engine: scope filter | 30 min |
| 5 | Update store tool: type guidance in prompts | 30 min |
| 6 | Update sleep prompts: new type names | 30 min |
| 7 | Update TOOLS.md / SOUL.md with new types | 15 min |
| 8 | Tests | 30 min |
| **Total** | | **~3 hr** |
