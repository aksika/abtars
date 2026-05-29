# Skills

Procedural knowledge the agent learns and reuses. A skill is a markdown file that teaches the agent how to do something — not facts, but *how-to*.

## Directory structure

Skills live in `~/.abtars/skills/`:

```
skills/
├── core/         # Bundled with abTARS (read-only)
├── self/         # Agent-created (agent-writable)
├── custom/       # Operator-provided
└── downloaded/   # From marketplace
```

| Directory | Who writes | Editable by agent |
|-----------|-----------|-------------------|
| `core/` | abTARS install/update | No |
| `self/` | The agent itself | Yes |
| `custom/` | You (the operator) | No |
| `downloaded/` | Marketplace fetch | No |

## How skills work

1. On boot, abTARS builds a **skill catalog** — a compact list of all available skills (name + description + tags)
2. The catalog is injected into the system prompt as guidance
3. When the model needs a skill, it reads the full `SKILL.md` on demand
4. The catalog guidance tells the model when to create or patch skills based on repeated patterns

The agent doesn't load every skill into context — just the catalog. Full skill content is pulled only when relevant.

## SKILL.md format

```markdown
---
name: deploy-peer-b
description: Deploy abTARS to the Mac mini via SSH
tags: [deploy, peer-b, ssh]
related: [deploy-kp, watchdog]
---

## Steps

1. SSH into peer-b...
2. Pull latest...
...
```

YAML frontmatter defines metadata. The markdown body is the actual procedure.

## Agent skill management

The agent can manage its own skills (in `self/` only):

| Tool | Purpose |
|------|---------|
| `skill_create` | Create a new skill from learned procedure |
| `skill_update` | Rewrite an existing skill |
| `skill_patch` | Partial update (add/modify a section) |
| `skill_remove` | Delete a skill |

The agent creates skills when it notices it's repeating a procedure — the catalog guidance prompts this behavior.

## Usage tracking

Each skill has a `.stats.json` sidecar tracking how often it's used:

```json
{
  "uses": 14,
  "lastUsed": "2026-05-20T09:30:00Z",
  "created": "2026-04-10T14:00:00Z"
}
```

## Commands

```
/skill          Reload the skill catalog (picks up new/changed files)
```
