# Deploy

**Command:** `./scripts/deploy.sh` (full) or `./scripts/deploy.sh --quick` (skip build + tmux restart)

**Source:** repo (`/home/qakosal/workspace/agentbridge/`)
**Runtime:** `~/.agentbridge/`

## What deploy does

### 1. `.env` merge

- If `~/.agentbridge/.env` doesn't exist → copy `.env.example` as starting point
- If it exists → merge new keys from `.env.example` only. Existing values never overwritten. Local-only keys (not in `.env.example`) are ignored.
- Deploy never reads `.env.kp` or `.env.molty` — those are backups in the repo.

### 2. `.env.memory` (ABM config)

Created from `.env.memory.example` if missing. Never overwritten if exists.

### 3. Build (`--quick` skips this)

`npm run build` → TypeScript → `dist/`

### 4. Copy runtime

- `dist/` → `~/.agentbridge/dist/`
- `node_modules/` → `~/.agentbridge/node_modules/`

### 5. Copy knowledgebase

Knowledge base files → `~/.agentbridge/`

### 6. Generate CLI wrappers

Creates bash scripts for `agentbridge-recall`, `agentbridge-store`, `agentbridge-edit`, `agentbridge-sleep`, `agentbridge-embed`, `agentbridge-todo`, `agentbridge-skill`, etc. Each wrapper sets `NODE_PATH` and calls the compiled JS.

### 7. Deploy persona

| Source | Destination | Overwrite behavior |
|---|---|---|
| `persona/core/SOUL.md`, `TOOLS.md` | `~/.agentbridge/core/` | Always overwritten |
| `persona/core/user_profile.md`, `agent_notes.md` | `~/.agentbridge/memory/core/` | **KEPT if newer** — never overwrites agent-modified files |
| `persona/prompts/sleep/*.md` | `~/.agentbridge/prompts/sleep/` | Always overwritten (14 prompt files) |
| `persona/prompts/browsing_prompt.md` | `~/.agentbridge/prompts/` | **KEPT if newer** |
| `persona/skills/*.md` | `~/.agentbridge/skills/` | **KEPT if newer** |
| `persona/agents/professor.json` | `~/.agentbridge/agents/` | **KEPT if newer** |
| Transport profiles | `~/.agentbridge/transports/` | Existing preserved |

### 8. Deploy launcher

- `~/.agentbridge/agentbridge.sh` — start/stop script
- Links mcporter CLI if available
- Checks ollama + embedding model availability

## Env file hierarchy (load order)

```
~/.agentbridge/.env              ← bridge config (managed by deploy merge)
~/.agentbridge/.env.skills       ← skill/integration config + secrets (HA, Groq, NLM — never touched by deploy)
~/.agentbridge/transports/*.env  ← transport profile overrides (AGENT_TRANSPORT_PROFILE selects which)
```

Bridge loads in this order: `.env` → `.env.skills` (overrides) → transport profile (overrides `AGENT_*` vars).

## Starting the bridge

```bash
~/.agentbridge/agentbridge.sh              # Discord (default)
~/.agentbridge/agentbridge.sh --telegram   # Telegram only
~/.agentbridge/agentbridge.sh --all        # Both platforms
~/.agentbridge/agentbridge.sh --all --web  # Both + web dashboard
~/.agentbridge/agentbridge.sh stop         # Stop everything
```

## Key rules

- **Never edit deployed files directly** — edit source in repo, then deploy
- **Exception:** `~/.agentbridge/.env` and `~/.agentbridge/.env.local` are edited directly (they contain secrets)
- **Exception:** `~/.agentbridge/memory/core/user_profile.md` and `agent_notes.md` are edited by the agent/Dreamy at runtime
- All agent output goes inside `~/.agentbridge/` — never write outside
