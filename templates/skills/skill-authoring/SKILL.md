---
name: skill-authoring
description: When to use skill_create (procedures) vs memory_store (facts)
---

# Skill Authoring Guide

## Output directory rule

**All skill output MUST go to `~/.abtars/workspace/<skill-name>/`.**

All skill/task output goes to `~/.abtars/workspace/<skill-or-task-name>/`. No exceptions. The workspace directory is the skill's sandbox — keeps outputs organized, discoverable, and isolated.

Examples:
- twitterX → `~/.abtars/workspace/twitterX/output/`
- browse → `~/.abtars/workspace/browse/`
- topics → `~/.abtars/workspace/topics/`


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
# Clear stale Node modules after upgrade

## When to use
Node app fails to start with "Cannot find module" errors after upgrading a dependency.

## How
1. Delete node_modules and package-lock.json
2. Run `npm install`
3. Restart the affected service

## Why
Stale lockfiles reference module versions that no longer exist. A clean install resolves current versions.
```

## Bad skill content (use memory_store instead)

- "User prefers tabs over spaces" → memory_store
- "Meeting with X on Tuesday" → memory_store
- "Bug #123 was caused by Y" → memory_store (unless the fix is a reusable recipe)

## Skill file structure

```
<skill-name>/
  ├── SKILL.md          ← required: description + instructions
  ├── scripts/          ← optional: executable scripts (py, sh, js)
  └── references/       ← optional: reference docs
```

**Rules for scripts:**
- Scripts go in `<skill>/scripts/`. Never at the skill root.
- Scripts must be self-contained. Use only Node built-ins, system binaries, or deps declared in SKILL.md metadata.
- **NEVER bundle node_modules/ inside a skill.** If a script needs a package, declare it in the skill metadata under `requires.bins` or `requires.packages`. The user installs it system-wide.
- Scripts must be executable (`chmod +x`).
- Prefer sh/bash for simple automation. Use Python/Node only when necessary.
