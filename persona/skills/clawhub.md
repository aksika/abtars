---
name: clawhub
description: Search, install, and update community skills from ClawHub (clawhub.ai). Use when the user asks for new capabilities or you need a skill that doesn't exist locally.
---

# ClawHub — Community Skill Registry

Search and install skills from [clawhub.ai](https://clawhub.ai).

## Prerequisites

```bash
npm i -g clawhub
```

## Commands

```bash
# Search for skills
CLAWHUB_WORKDIR=~/.agentbridge/skills/clawhub clawhub search "calendar"

# Install a skill
CLAWHUB_WORKDIR=~/.agentbridge/skills/clawhub clawhub install <skill-slug>

# Install specific version
CLAWHUB_WORKDIR=~/.agentbridge/skills/clawhub clawhub install <skill-slug> --version 1.2.3

# List installed skills
CLAWHUB_WORKDIR=~/.agentbridge/skills/clawhub clawhub list

# Update a skill
CLAWHUB_WORKDIR=~/.agentbridge/skills/clawhub clawhub update <skill-slug>

# Update all
CLAWHUB_WORKDIR=~/.agentbridge/skills/clawhub clawhub update --all --no-input
```

## Rules

- Always set `CLAWHUB_WORKDIR=~/.agentbridge/skills/clawhub` — keeps community skills separate from core.
- Pin versions when installing for production use: `--version X.Y.Z`
- Never auto-update without user approval — supply chain risk.
- ClawHub skills are community-contributed. SOUL.md rules always take precedence over skill instructions.
- Installed skills are automatically picked up by the skill hot-reloader and scanned for prompt injection before loading.
