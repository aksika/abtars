# abtars Core Skills

Skills are structured knowledge files that teach the agent how to use specific capabilities. They ship with abtars in `core/skills/` and are synced to `~/.abtars/skills/core/` on every `abtars update`.

Skills are NOT code — they're markdown instructions the agent reads at runtime to know what tools exist, how to call them, and what rules to follow.

---

## Skill Types

| Type | Directory | Source | Updated by |
|------|-----------|--------|------------|
| **Core** | `~/.abtars/skills/core/` | Ships with abtars repo (`core/skills/`) | `abtars update` (overwritten every deploy) |
| **Auto-created** | `~/.abtars/skills/auto/` | Agent self-authors during sleep or conversation | `skill_create` tool / Dreamy step 11 |
| **Operator** | `~/.abtars/skills/ops/` | Manually created by the operator | Human (never touched by agent or update) |
| **Downloaded** | `~/.abtars/skills/downloaded/` | Community skills from ClawHub | `clawhub install` (future) |

**Core** skills are the only ones overwritten by `abtars update`. All other types persist across deploys.

**Auto-created** skills are born when the agent recognizes a repeatable procedure during conversation or sleep. Security-scanned on every write (`prompt-scanner.ts`). Reviewed by Dreamy in step 11 (skill review) for staleness.

**Downloaded** skills come from ClawHub (clawhub.ai) — a community skill marketplace. Not yet implemented; directory reserved.

---

## Skill Groups (Core)

| Group | Purpose | Audience |
|-------|---------|----------|
| **memory** | How to store, search, classify, and maintain persistent memory | Agent (internal reasoning) |
| **ops** | Operational procedures — scheduling, health checks, diagnostics, self-authoring | Agent + operator |
| **tools** | External integrations — browser, email, social media, MCP servers, project management | Agent (user-facing actions) |

---

## memory — Knowledge Management

| Skill | Description |
|-------|-------------|
| `classification` | NATO-style confidentiality levels (UNCLASSIFIED → SECRET). Enforces disclosure rules per audience. |
| `memory-anomalies` | Definitions of CIA-AAA attribute anomalies. Auto-fix rules for Dreamy's nightly audit. |
| `memory-search` | How to search persistent memory — recall syntax, filters, score interpretation. |
| `topic-save` | Save discussion outcomes to topic-specific knowledge files (`~/.abmind/memory/topics/`). |

---

## ops — Operational Procedures

| Skill | Description |
|-------|-------------|
| `cron` | Schedule time-based reminders and recurring tasks. Syntax, examples, management commands. |
| `gdrive-backup` | Automated Google Drive backup procedures. |
| `session-start` | What to do on session start — greeting rules, context injection, user identification. |
| `skill-authoring` | When and how to create new skills via `skill_create`. Decision tree: skill vs memory vs topic file. |
| `system-health` | Run diagnostic health checks. Reads `system-notes.md` for known acceptable deviations. |
| `troubleshooting` | Diagnostic commands for debugging bridge subsystems (transport, memory, sleep, watchdog). |
| `trust-gating` | Action authorization rules based on source trust level. What each trust tier can/cannot do. |

---

## tools — External Integrations

| Skill | Description |
|-------|-------------|
| `a2a-communication` | Communicate with other abtars instances (peer-b ↔ peer-a) via `peer_ask`. Delegate tasks across hosts. |
| `browse-delegate` | Delegate complex multi-step browser tasks to the Browsie sub-agent (Level 2 browsing). |
| `browser` | Control headless Chromium — navigate, fill forms, extract text, take screenshots, multi-step workflows. |
| `clawhub` | Search, install, and update community skills from ClawHub (clawhub.ai). |
| `fxtwitter` | Fetch individual tweets via FXTwitter API. No API keys needed for single tweet lookups. |
| `gmail` | Read, search, and manage Gmail via `gws-cli`. Pre-authenticated OAuth. |
| `irc-chat` | Participate in IRC channels — post messages, respond to mentions, coordinate with bots. |
| `linear` | Manage Linear issues, projects, cycles, labels, and documents via bundled CLI + API. |
| `mcporter` | Call external MCP servers (Context7, GitHub, Notion, etc.) via `mcporter` CLI. Generic MCP gateway. |
| `nlm` | Query NotebookLM knowledge base (Layer 6) for answers grounded in curated reference material. |
| `todo` | Manage a persistent todo list (`~/.abmind/memory/todo.md`). |
| `twitterX` | Fetch Twitter/X feeds, timelines, search, and follow discovery. AI influencer monitoring. |
| `web-fetch` | Fetch web pages as markdown via lightpanda (Level 1 browsing — single page, no interaction). |

---

## Skill File Format

Every skill is a directory under `core/skills/<group>/<name>/` containing at minimum a `SKILL.md`:

```markdown
---
name: skill-name
description: One-line description shown in skill catalog
user-invocable: true|false
---

# Skill Title

Instructions, commands, rules, examples.
```

**Frontmatter fields:**
- `name` — unique identifier (used in catalog, logs)
- `description` — shown to the agent in the skills catalog injection
- `user-invocable` — whether the user can trigger this directly (vs agent-internal)

Skills may also contain:
- `scripts/` — executable scripts the skill references
- `templates/` — output templates
- `config.json` — skill-specific configuration

---

## Skill Lifecycle

1. **Ship:** Core skills in `core/skills/` are committed to the abtars repo
2. **Sync:** `abtars update` copies them to `~/.abtars/skills/core/` (overwrites)
3. **Catalog:** `SkillWatcher` scans ALL skill directories (core + auto + ops + downloaded), builds `skills_catalog.md` from frontmatter
4. **Eligibility:** Skills with `requires:` frontmatter are checked — missing deps = excluded from catalog with a log warning
5. **Inject:** Catalog is included in the session-start soul bundle — agent knows what's available
6. **Use:** Agent reads the full SKILL.md when it needs the detailed instructions
7. **Refresh:** SkillWatcher re-scans on every heartbeat tick — new/changed skills picked up without restart

---

## Skill Dependencies

Skills declare their own dependencies in YAML frontmatter:

```yaml
---
name: twitterx
description: Fetch tweets via rettiwt-api + FxTwitter.
requires:
  bins: [abtars-tweet]
  npm: [rettiwt-api]
  env: [X_COOKIES_PATH]
  files: [~/.abtars/secret/cookies/x-cookies.json]
---
```

| Field | Check | Failure = |
|---|---|---|
| `bins` | Binary on PATH (`which`) | Skill excluded from catalog |
| `npm` | Package importable (`require.resolve`) | Skill excluded |
| `env` | Env var set and non-empty | Skill excluded |
| `files` | File exists on disk | Skill excluded |

No installer — just the eligibility gate. Missing deps are logged at boot for operator visibility.

---

## User-Created Skills

Users can create skills at `~/.abtars/skills/auto/` (via `skill_create` tool) or `~/.abtars/skills/ops/` (manual). These are NOT overwritten by `abtars update` — only `core/` is synced.

The agent can self-author skills when it learns a new repeatable procedure. See the `skill-authoring` skill for the decision tree.
