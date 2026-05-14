---
name: skill-authoring
description: When to use skill_create vs memory_store. Use skill_create for repeatable procedures/recipes; use memory_store for facts, events, preferences.
---

# Skill Authoring Guide

## Output directory rule

**All skill output MUST go to `~/.abtars/workspace/<skill-name>/`.**

Never write to `~/.abtars/<random>/` or `~/.abtars/reports/` directly. The workspace directory is the skill's sandbox — keeps outputs organized, discoverable, and isolated.

Examples:
- twitterX → `~/.abtars/workspace/twitterX/output/`
- browse → `~/.abtars/workspace/browse/`
- topics → `~/.abtars/workspace/topics/`

Reports that get sent to the user go to `~/.abtars/reports/<category>/` (separate from workspace — reports are delivery artifacts, workspace is working state).

## When to use `skill_create`

- You solved a novel task and the steps are reusable
- You discovered a workflow or recipe worth remembering
- You received a correction that applies to a class of problems (not just one instance)
- The knowledge is procedural: "how to do X"

## When to use `memory_store` instead

- The information is a fact, event, or preference ("user likes X")
- It's specific to one conversation or moment
- It's declarative: "what happened" or "what is true"

## Good skill content

```markdown
# Fix pnpm workspace drift

## When to use
pnpm install fails with "workspace protocol" errors after adding a new package.

## How
1. Delete node_modules and pnpm-lock.yaml
2. Run `pnpm install --no-frozen-lockfile`
3. Commit the updated lockfile

## Why
pnpm workspace protocol (`workspace:*`) resolves at install time. Stale lockfiles reference old resolutions.
```

## Bad skill content (use memory_store instead)

- "User prefers tabs over spaces" → memory_store
- "Meeting with X on Tuesday" → memory_store
- "Bug #123 was caused by Y" → memory_store (unless the fix is a reusable recipe)
