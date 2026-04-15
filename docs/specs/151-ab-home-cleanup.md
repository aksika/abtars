# #151 AB_HOME Directory Cleanup

**Date:** 2026-04-15
**Status:** Planned
**Priority:** MEDIUM

## Problem

`~/.agentbridge/` is a flat mess. Loose scripts, stale env files, mixed concerns at root level. Hard to navigate, hard to back up selectively, hard to explain to new users.

### Current state (41 items at root)

```
~/.agentbridge/
├── agentbridge-embed          ← loose script (should be bin/)
├── agentbridge.sh             ← loose launcher (should be bin/)
├── browser-docker.sh          ← loose script
├── browser-lightpanda.sh      ← loose script
├── browser-patchright.sh      ← loose script
├── mcporter                   ← loose script
├── bridge.lock                ← runtime (ok at root)
├── memory.sock                ← runtime socket (ok at root)
├── memory.env                 ← stale? duplicate of config/.env.memory?
├── .env                       ← config (should be config/)
├── .env.memory                ← stale (migrated to config/)
├── .env.old                   ← stale backup
├── .env.skills                ← stale (migrated to config/)
├── professor.json             ← config (should be config/)
├── package.json               ← runtime (needed by node)
├── agents/                    ← persona
├── backup/                    ← ok
├── bin/                       ← already exists, underused
├── browser-socket/            ← runtime
├── config/                    ← already exists, incomplete
├── core/                      ← persona
├── dist/                      ← runtime
├── docker/                    ← infra
├── finance/                   ← data
├── knowledgebase/             ← persona
├── logo/                      ← assets
├── logs/                      ← ok
├── memory/                    ← data
├── node_modules/              ← runtime
├── notebooklm/                ← data
├── overflow/                  ← runtime
├── prompts/                   ← persona
├── received/                  ← data
├── reports/                   ← data
├── scripts/                   ← already exists, has copies
├── secret/                    ← ok (chmod 700)
├── skills/                    ← persona
├── subagents/                 ← persona
├── tasks/                     ← persona
├── topics/                    ← data
├── transports/                ← runtime? stale?
├── twitterX/                  ← data
├── workspace/                 ← agent workspace
```

## Target structure

```
~/.agentbridge/
├── bin/                       ← ALL executables + launchers
│   ├── agentbridge.sh
│   ├── browser-patchright.sh
│   ├── browser-lightpanda.sh
│   ├── browser-docker.sh
│   ├── agentbridge-embed
│   ├── mcporter
│   └── abmind → (wrapper)
│
├── config/                    ← ALL configuration
│   ├── .env
│   ├── .env.memory
│   ├── .env.skills
│   ├── transport.json
│   ├── models.json
│   ├── auto-fix.json
│   └── professor.json
│
├── secret/                    ← credentials (chmod 700)
│   ├── db.key
│   ├── abmind.key
│   └── cookies/
│
├── persona/                   ← agent identity (grouped)
│   ├── core/                  ← SOUL, agent_notes, core_facts, user_profile
│   ├── prompts/               ← system prompts + sleep/
│   ├── skills/                ← core/, auto/, clawhub/
│   ├── agents/                ← CODING.md etc
│   ├── subagents/
│   └── tasks/
│
├── data/                      ← persistent data (grouped)
│   ├── memory/                ← memory.db, sleep/, retrospectives/
│   ├── finance/
│   ├── twitterX/
│   ├── topics/
│   ├── reports/
│   ├── notebooklm/
│   └── received/
│
├── knowledgebase/             ← asbuilts, reference docs
├── backup/                    ← git-pushed backups
├── logs/                      ← bridge.log
├── workspace/                 ← agent working dir
│
├── runtime/                   ← transient (not backed up)
│   ├── dist/
│   ├── node_modules/
│   ├── package.json
│   ├── overflow/
│   ├── browser-socket/
│   └── docker/
│
├── bridge.lock                ← root (health signal, needs to be findable)
├── memory.sock                ← root (IPC socket)
├── .git/                      ← backup repo
├── .gitignore
└── .gitattributes
```

## Key changes

| What | From | To |
|---|---|---|
| Loose scripts | root (`*.sh`, `mcporter`, `agentbridge-embed`) | `bin/` |
| `.env`, `.env.memory`, `.env.skills` | root (stale copies) | `config/` only |
| `professor.json` | root | `config/` |
| `core/`, `prompts/`, `skills/`, `agents/`, `subagents/`, `tasks/` | root | `persona/` |
| `memory/`, `finance/`, `twitterX/`, `topics/`, `reports/`, `notebooklm/`, `received/` | root | `data/` |
| `dist/`, `node_modules/`, `package.json`, `overflow/`, `browser-socket/`, `docker/` | root | `runtime/` |
| `logo/` | root | `runtime/` or remove |
| `transports/` | root | investigate — likely stale, remove |
| `.env.old` | root | delete |
| `memory.env` | root | delete (duplicate) |

## What stays at root

- `bridge.lock` — health signal, scripts check for it
- `memory.sock` — IPC socket
- `.git*` — backup repo

## Implementation

| Step | What | Effort |
|---|---|---|
| 1 | Move loose scripts → `bin/`, update PATH references in deploy.sh | 15 min |
| 2 | Move stale .env files → `config/`, delete `.env.old`, `memory.env` | 10 min |
| 3 | Move `professor.json` → `config/` | 5 min |
| 4 | Create `persona/` — move core, prompts, skills, agents, subagents, tasks | 15 min |
| 5 | Create `data/` — move memory, finance, twitterX, topics, reports, notebooklm, received | 15 min |
| 6 | Create `runtime/` — move dist, node_modules, package.json, overflow, browser-socket, docker | 10 min |
| 7 | Update all path references in bridge source (`AB_HOME + "/core"` → `AB_HOME + "/persona/core"` etc) | 1 hr |
| 8 | Update deploy.sh — new target paths | 30 min |
| 9 | Update doctor.sh — new check paths | 15 min |
| 10 | Update daily-backup.sh — new zip paths | 10 min |
| 11 | Update .gitignore — runtime/ excluded, persona/ + data/ included | 10 min |
| 12 | Migration in doctor.sh: detect old layout → move to new | 30 min |
| 13 | Update asbuilts | 15 min |
| 14 | Test: deploy + doctor + backup on new layout | 20 min |
| **Total** | | **~3.5 hr** |

## Migration strategy

`doctor.sh --fix` detects old layout (checks for `core/` at root) and migrates:

```bash
# One-time migration
if [ -d "$AB/core" ] && [ ! -d "$AB/persona" ]; then
  mkdir -p "$AB/persona" "$AB/data" "$AB/runtime"
  mv "$AB/core" "$AB/prompts" "$AB/skills" "$AB/agents" "$AB/subagents" "$AB/tasks" "$AB/persona/"
  mv "$AB/memory" "$AB/finance" "$AB/twitterX" "$AB/topics" "$AB/reports" "$AB/notebooklm" "$AB/received" "$AB/data/"
  mv "$AB/dist" "$AB/node_modules" "$AB/package.json" "$AB/overflow" "$AB/browser-socket" "$AB/docker" "$AB/logo" "$AB/runtime/"
  # scripts
  mv "$AB/agentbridge.sh" "$AB/browser-"*.sh "$AB/agentbridge-embed" "$AB/mcporter" "$AB/bin/" 2>/dev/null
  # stale env
  rm -f "$AB/.env.old" "$AB/memory.env"
  [ -f "$AB/.env" ] && mv "$AB/.env" "$AB/config/.env"
  [ -f "$AB/.env.memory" ] && mv "$AB/.env.memory" "$AB/config/.env.memory"
  [ -f "$AB/.env.skills" ] && mv "$AB/.env.skills" "$AB/config/.env.skills"
  [ -f "$AB/professor.json" ] && mv "$AB/professor.json" "$AB/config/professor.json"
fi
```

## Risks

| Risk | Mitigation |
|---|---|
| Bridge running during migration | doctor.sh checks bridge.lock — warn if bridge is running, skip migration |
| Hardcoded paths in persona .md files | grep + fix — most use relative refs |
| Mac agent has different layout | Same doctor.sh migration runs on both |
| Git backup repo paths change | .gitignore update + one `git add -A` after migration |

## Notes

- `transports/` — investigate before migration. Likely stale from old transport config. Delete if empty/unused.
- `logo/` — only used by dashboard. Move to `runtime/` or `config/`.
- After migration, root should have ≤10 items (bin, config, secret, persona, data, knowledgebase, backup, logs, workspace, runtime + lock/sock/git).
