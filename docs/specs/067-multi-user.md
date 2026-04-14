# #67 Multi-User Support

**Date:** 2026-04-14
**Status:** Planned
**Priority:** HIGH
**Depends on:** #145 (restrict passthrough commands)

## Goal

Family-scale multi-user (2-4 people) on one bridge instance. Isolated sessions, classification-based memory privacy, no tools for non-master.

## Roles

| Role | Source | Transport | Tools | Injection scan |
|---|---|---|---|---|
| master | .env | any (configured) | all | skip (trusted) |
| user | .env | Direct API only | none | ✓ |
| guest | runtime (/approve) | Direct API only | none | ✓ |

## Auth config

```env
# Format: userId:role:maxClass:telegramId[:discordId]
USERS=master:master:3:7773842843,adrika:user:1:8385860222
```

Replaces `ALLOWED_USER_IDS`. Both Telegram and Discord closed by default — allowlist only.

Guest: approved at runtime via `/approve <platformId>`, persisted to `~/.agentbridge/config/guests.json`. Hardcoded maxClass=0.

## Classification & recall

| Class | Label | Description |
|---|---|---|
| 0 | World | Public knowledge, visible to everyone |
| 1 | Internal | Family/project knowledge |
| 2 | Master | Private to master |
| 3 | Non-disclosed | Secret — agent uses internally, never outputs in chat |

**Per-user maxClass** set in .env. Controls what the agent can recall for that user.

- **Master (maxClass=3):** Agent recalls everything. Class 3 memories are used for internal reasoning but NEVER disclosed in chat responses. Enforced via SOUL.md prompt instruction.
- **User (maxClass=0-2):** Recall query filters `WHERE classification <= maxClass`. Memories above their level never enter the context. No output filtering needed — data simply isn't there.
- **Guest (maxClass=0):** World only. Hardcoded.

Store defaults:
- Master: classification=1 (can store any level 0-3)
- User: classification=1 (can store up to their maxClass)
- Guest: cannot store

## Transport

- Master: uses configured transport from transport.json (ACP, Direct API, any provider)
- User/Guest: always Direct API with `tools: []` (no tool calls). Same endpoint/model as master's Direct API provider. Separate session per user.

Constraint: user/guest only go through API. No ACP/kiro/gemini CLI sessions — avoids multi-user CLI conflicts.

## Commands

| Command | Master | User/Guest |
|---|---|---|
| `/new`, `/reset`, `/stop` | ✓ | ✓ |
| `/status`, `/help` | ✓ | ✓ |
| `/models`, `/compact`, `/coding` | ✓ | ⛔ |
| `/tasks`, `/memory`, `/heartbeat` | ✓ | ⛔ |
| `/restart`, `/healing`, `/facts` | ✓ | ⛔ |
| `/wakeup`, `/skills` | ✓ | ⛔ |
| `/approve`, `/revoke`, `/users` | ✓ | ⛔ |
| `//` passthrough, `!` shell | ✓ (after #145) | ⛔ |

Non-master commands blocked with: "⛔ Owner-only command."

## Memory behavior per role

| | Master | User | Guest |
|---|---|---|---|
| Messages in DB | ✓ | ✓ | ✗ (context window only) |
| Sleep extracts | ✓ | ✗ (ignored) | ✗ |
| Daily summaries | ✓ | ✗ | ✗ |
| Recall | class ≤ maxClass | class ≤ maxClass | class ≤ 0 |
| Store | any class (0-3) | up to maxClass | ✗ |
| Wake-up | full ABM | last-session summary | "Hi! How can I help?" |

## Session key

`{userId}:{platform}` — e.g. `master:telegram`, `adrika:telegram`

## User registry

Parsed at startup from .env + guests.json:

```typescript
interface UserEntry {
  userId: string;
  role: "master" | "user" | "guest";
  maxClass: number;          // 0-3
  displayName?: string;
  platforms: { telegram?: number; discord?: string };
  lastPlatform?: string;     // delivery context
  lastChatId?: number | string;
}
```

## Master-only commands

| Command | What |
|---|---|
| `/approve <platformId>` | Add guest |
| `/revoke <userId>` | Remove guest |
| `/users` | List all users with roles + maxClass |

## Implementation

### Phase 0 — User definitions + core injection (~1hr)

Foundation: define users in .env, parse at startup, inject user context into sessions.

| Step | What | Time |
|---|---|---|
| 0a | Add `# Users` section to .env.example with USERS format + docs | 10 min |
| 0b | `parseUsers()` in config.ts — parse USERS env → UserEntry[] map | 20 min |
| 0c | Add user context to soul-loader: inject `[USERS]` section into core bundle listing all users with roles (agent knows who it's talking to) | 15 min |
| 0d | `buildSessionStartPrompt` receives userId — injects "You are now talking to {displayName} ({role})" | 15 min |

#### .env.example addition

```env
# ============================================================
# Users
# ============================================================
# Format: userId:role:maxClass:telegramId[:discordId]
# Roles: master (full access), user (chat only, no tools), guest (runtime, /approve)
# maxClass: max Classification level (0=World, 1=Internal, 2=Master, 3=Non-disclosed)
USERS=master:master:3:7773842843
```

#### Core injection

The soul bundle gets a `[USERS]` block so the agent knows the household:

```
[USERS]
- aksika (master, maxClass=3) — Telegram: 7773842843
- adrika (user, maxClass=1) — Telegram: 8385860222

Current session: aksika (master)
```

This lets the agent:
- Address users by name
- Know what it can/cannot disclose per user
- Adjust tone (master gets full technical detail, user gets friendly chat)

### Phase 1 — Identity + routing (~5hr)

| Step | What | Time |
|---|---|---|
| 1 | Parse `USERS` env → user registry + load guests.json | 30 min |
| 2 | Security gate: platformId → userId + role + maxClass | 30 min |
| 3 | Unknown sender → reject. `/approve` adds guest | 30 min |
| 4 | Session key `{userId}:{platform}` — update pipeline, adapters | 1 hr |
| 5 | Transport: master=configured, user/guest=DirectAPI with tools:[] | 30 min |
| 6 | Command whitelist for non-master (middleware check) | 30 min |
| 7 | Injection scan for non-master messages | 15 min |
| 8 | `/approve`, `/revoke`, `/users` commands | 30 min |
| 9 | Delivery context (lastPlatform per user) | 15 min |
| 10 | Tests | 30 min |

### Phase 2 — Memory separation (~2hr)

Schema already done (user_id column on all tables, extraction_watermarks keyed by user_id, migration defaults to master). Only wiring remains.

| Step | What | Time |
|---|---|---|
| 11 | Recall: add `WHERE user_id = ? AND classification <= ?` filter | 30 min |
| 12 | Store: tag with userId, enforce maxClass limit per role | 15 min |
| 13 | Sleep: filter extraction to master's user_id only | 15 min |
| 14 | Guest: skip DB write entirely (context window only) | 15 min |
| 15 | Wake-up: master=full ABM, user=last-session summary, guest=generic | 30 min |
| 16 | Tests | 15 min |

### Phase 3 — Profiles + polish (~2hr)

| Step | What | Time |
|---|---|---|
| 19 | `user_profile_{userId}.md` per user | 30 min |
| 20 | Session-start injects correct user profile | 15 min |
| 21 | SOUL.md: class 3 non-disclosure rule | 15 min |
| 22 | displayName in registry → dashboard + logs | 15 min |
| 23 | Document security model (classification = privacy, not enforcement) | 15 min |
| 24 | End-to-end test: master + user simultaneous | 30 min |

**Total: ~10hr. Phase 0 alone gives the agent user awareness.**

## Schema (already done)

`user_id TEXT DEFAULT 'aksika'` added to: messages, extracted_memories, ingested_documents, entities. `extraction_watermarks` keyed by user_id (per-user sleep extraction). Migration defaults existing data to master's userId. Done in abmind repo.

## What stays shared

- Agent personality (SOUL.md, agent_notes.md)
- Skills (master only uses them via tools, but they're loaded once)
- Cron system (master's tasks)
- Dashboard (master access only)
- Model/endpoint config

## Migration

- `ALLOWED_USER_IDS` → `USERS` (new format, old var as fallback if USERS missing)
- Existing memories: `user_id` already defaults to master's userId (done in abmind schema)
- Existing session keys (`telegram:123`) → mapped to userId on first message

## Security notes

- Classification is agent-level privacy, not OS-level enforcement. A master with bash can query the DB directly. Acceptable for family trust model.
- Class 3 non-disclosure relies on prompt instruction. A sufficiently clever prompt injection could bypass it. Defense: class 3 memories should also be encrypted at rest (#45) for true protection.
- User/guest with no tools cannot execute code, browse, or modify files. Pure conversation only.
- All user/guest messages scanned for injection (#127) before reaching the model.
