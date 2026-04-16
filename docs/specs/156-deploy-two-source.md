# deploy.sh Rewrite — Two-Source Persona Deploy

## Context

`persona/` removed from agentbridge (public repo). Replaced by:
- `agentbridge/core/` — generic templates, prompts, skills, config
- `abproject/persona/` — personal overrides (private repo)

## Deploy Sources

### Layer 1: agentbridge/core/ (base)

| Source | Destination |
|---|---|
| `core/core_templates/*.md` | `~/.agentbridge/core/` (fallback if no personal override) |
| `core/prompts/*.md` | `~/.agentbridge/prompts/` |
| `core/prompts/sleep/*.md` | `~/.agentbridge/prompts/sleep/` |
| `core/skills/*.md` | `~/.agentbridge/skills/core/` |
| `core/config/*` | `~/.agentbridge/config/` |
| `core/professor.json` | `~/.agentbridge/professor.json` |

### Layer 2: abproject/persona/ (overlay, optional)

| Source | Destination |
|---|---|
| `persona/core/*.md` | `~/.agentbridge/core/` (overrides templates) |
| `persona/skills/personal/*.md` | `~/.agentbridge/skills/personal/` |
| `persona/tasks/*` | `~/.agentbridge/tasks/` |
| `persona/agents/*.md` | `~/.agentbridge/agents/` |

### Not from abproject
- Config (auto-fix.json etc) → agentbridge
- Prompts (compaction, sleep, browsing) → agentbridge
- professor.json → agentbridge

## Deploy Order

1. Generic from `agentbridge/core/` (base layer)
2. Personal from `abproject/persona/` (overlay — overrides matching files in core/)

## ABPROJECT_DIR

`ABPROJECT_DIR` env var — defaults to `~/workspace/ab/abproject`.
If directory doesn't exist, skip Layer 2 (public-only install works without personal files).

## Implementation

1. Replace all `$PROJECT_DIR/persona/` refs in deploy.sh with `$PROJECT_DIR/core/`
2. Add Layer 2 section: if `$ABPROJECT_DIR/persona/` exists, overlay personal files
3. Keep `safe_cp` logic (skip if deployed file is newer)
4. Test: full deploy with both repos, full deploy without abproject
