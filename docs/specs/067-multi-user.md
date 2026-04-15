# #67 Multi-User Support

**Date:** 2026-04-14
**Status:** Planned
**Priority:** HIGH
**Depends on:** #145 (done — restrict passthrough commands)

## Goal

Family-scale multi-user (2-4 people) on one bridge instance. Isolated sessions, classification-based memory privacy, no tools for non-master.

## Roles

| Role | Source | Transport | Tools | Injection scan |
|---|---|---|---|---|
| master | users.json | any (configured) | all (from config) | skip (trusted) |
| user | users.json | Direct API only | per-user (from config, e.g. web_fetch) | ✓ |
| guest | runtime (/approve) | Direct API only | none | ✓ |

## Auth config

`~/.agentbridge/config/users.json`:

```json
{
  "users": [
    {
      "userId": "aksika",
      "displayName": "aksika",
      "role": "master",
      "maxClass": 3,
      "tools": ["all"],
      "platforms": { "telegram": 7773842843 }
    },
    {
      "userId": "adrika",
      "displayName": "Adrika",
      "role": "user",
      "maxClass": 1,
      "tools": ["web_fetch"],
      "platforms": { "telegram": 8385860222 }
    }
  ]
}
```

Fallback: if no `users.json`, treat all `ALLOWED_USER_IDS` as master with maxClass=3 and all tools. Zero migration for single-user setups.

Guest: approved at runtime via `/users approve <platformId>`, appended to `users.json` with `role: "guest"`, `maxClass: 0`, `tools: []`. All users in one file.

## Classification & recall

| Class | Label | Description |
|---|---|---|
| 0 | World | Public knowledge, visible to everyone |
| 1 | Internal | Family/project knowledge — shared, no attribution |
| 2 | Confidential | Private to the storing user |
| 3 | Non-disclosed | Secret — agent uses internally, never outputs in chat |

**Per-user maxClass** set in users.json. Controls what the agent can recall for that user.

### Recall logic

Class 0-1 memories are shared knowledge — visible to anyone with sufficient clearance, regardless of who stored them. Class 2+ memories are private to the owner.

```sql
WHERE classification <= :maxClass AND (classification <= 1 OR user_id = :userId)
```

- **Master (maxClass=3):** Sees everything. Class 3 used for internal reasoning, never disclosed.
- **User (maxClass=1):** Sees all class 0-1 memories (shared pool). Cannot see class 2+ from any user.
- **Guest (maxClass=0):** World only.

### No-attribution rule (SOUL.md)

When talking to non-master users, the agent uses shared knowledge naturally but NEVER attributes it:
- ✓ "React uses JSX for templating" (uses knowledge)
- ✗ "Aksika mentioned that React uses JSX" (attributes to another user)
- ✓ "Pink would look great!" (uses preference knowledge)
- ✗ "You told me last time you like pink" (references past conversation directly is OK — it's the user's own)

### Confidentiality signals

During sleep extraction, if the user explicitly requests confidentiality ("between us", "don't tell anyone", "keep this private"), the memory is stored at class 2 (CONFIDENTIAL) instead of the default class 1. Detected by the LLM during extraction — no regex, natural language understanding.

### Store defaults

- Master: default class 1, can store any level 0-3. Confidentiality signals → class 2.
- User: default class 1, can store up to their maxClass. 
- Guest: cannot store.

## Transport

- Master: uses configured transport from transport.json (ACP or Direct API)
- User: always Direct API with tools from users.json (e.g. `["web_fetch"]`). Separate session per user.
- Guest: always Direct API with `tools: []` (no tool calls).

**Concurrent sessions:** DirectApiTransport is stateless — each sendPrompt() sends a full message array. Two users calling simultaneously make two HTTP requests. With OLLAMA_NUM_PARALLEL=2, they run concurrently. No per-user transport instance needed.

Constraint: user/guest always go through Direct API. No ACP for non-master — avoids CLI session conflicts. Master can also be on Direct API (both master and users share the same API endpoint). Requires at least one API provider in transport.json when users.json has non-master users (validated at startup).

## Commands

| Command | Master | User/Guest |
|---|---|---|
| `/new`, `/reset`, `/stop` | ✓ | ✓ |
| `/status`, `/help` | ✓ | ✓ |
| `/models`, `/compact`, `/coding` | ✓ | ⛔ |
| `/tasks`, `/memory`, `/heartbeat` | ✓ | ⛔ |
| `/restart`, `/healing`, `/facts` | ✓ | ⛔ |
| `/wakeup`, `/skills` | ✓ | ⛔ |
| `/users [approve/revoke]` | ✓ | ⛔ |
| `//` passthrough, `!` shell | ✓ (after #145) | ⛔ |

Non-master commands blocked with: "⛔ Owner-only command."

## Memory behavior per role

| | Master | User | Guest |
|---|---|---|---|
| Messages in DB | ✓ | ✓ | ✗ (context window only) |
| Sleep extraction | full (darwinism, promotion, merge, timelines) | lightweight (facts + preferences only) | ✗ |
| Daily summaries | ✓ | ✗ | ✗ |
| Recall | class ≤ 3 (shared + private + non-disclosed) | class ≤ maxClass (shared pool, no attribution) | class ≤ 0 |
| Store | any class (0-3) | class 0-1 | ✗ |
| Wake-up | full ABM | last-session summary | "Hi! How can I help?" |
| Guest session lifecycle | n/a | n/a | context fills → session resets (like /new). No compaction. |

### User extraction (lightweight)

Sleep scans user conversations and extracts:
- Facts: "we have a black Tesla", "my birthday is March 5"
- Preferences: "I love pink nails", "I prefer dark mode"
- Relationships: "my best friend is Anna"

Skips: opinions on technical topics, work discussions, emotional processing.
Tagged with `user_id` so the agent knows WHO said it.
Classification: class 1 (family knowledge) — master and other users benefit.
No promotion to core, no merge, no darwinism — just store and recall.

## Session key

`{userId}:{platform}` — e.g. `master:telegram`, `adrika:telegram`

## User registry

Parsed at startup from users.json. See schema in Phase 0. Runtime fields added: `lastPlatform` (delivery context — which platform user last messaged from), `lastChatId` (for cron/reminder delivery).

## Master-only commands

| Command | What |
|---|---|
| `/users approve <platformId>` | Add guest |
| `/users revoke <userId>` | Remove guest |
| `/users` | List all users with roles + clearance |

## Implementation

### Phase 0 — User definitions + core injection ✅ DONE

Foundation: define users in `~/.agentbridge/config/users.json`, parse at startup, inject user context into sessions.

| Step | What | Time |
|---|---|---|
| 0a | Define `UserEntry` type + `loadUsers()` — read users.json, fallback to ALLOWED_USER_IDS | 20 min |
| 0b | Build platform ID → UserEntry lookup map | 10 min |
| 0c | Soul-loader: inject `[USERS]` block into core bundle | 15 min |
| 0d | `buildSessionStartPrompt` receives userId — injects "You are now talking to {userId} ({role})" | 15 min |

#### users.json schema

```typescript
interface UserEntry {
  userId: string;
  role: "master" | "user" | "guest";
  maxClass: number;       // 0-3 (NATO classification)
  tools: string[];        // ["all"] or ["web_fetch"] or []
  displayName?: string;   // human-readable name for dashboard + logs
  platforms: {
    telegram?: number;
    discord?: string;
  };
}
```

#### Core injection

The soul bundle gets a `[USERS]` block so the agent knows the household:

```
[USERS]
- aksika (master, SECRET clearance)
- adrika (user, RESTRICTED clearance)

Current session: aksika (master)
```

This lets the agent:
- Address users by name
- Know what it can/cannot disclose per user
- Adjust tone (master gets full technical detail, user gets friendly chat)

### Phase 1 — Identity + routing (~5hr)

| Step | What | Time |
|---|---|---|
| 1 | Load users.json at startup → user registry (guests stored in same file) | 20 min |
| 2 | Security gate: platformId → userId + role + maxClass | 30 min |
| 3 | Unknown sender → reject. `/users approve` adds guest | 30 min |
| 4 | Session key `{userId}:{platform}` — update pipeline, adapters | 1 hr |
| 5 | Transport: master=configured, user/guest=DirectAPI with tools from users.json (guest=[]) | 30 min |
| 6 | Command whitelist for non-master (middleware check) | 30 min |
| 7 | Injection scan for non-master messages | 15 min |
| 8 | `/users`, `/users approve`, `/users revoke` commands + update `/help` | 30 min |
| 9 | Delivery context (lastPlatform per user) | 15 min |
| 10 | Update cronCallback session key: `telegram:{chatId}` → `{userId}:{platform}` | 15 min |
| 11 | Tests | 30 min |

### Phase 2 — Memory separation (~3hr)

Schema already done (user_id column on all tables, extraction_watermarks keyed by user_id, migration defaults to master). Only wiring remains.

| Step | What | Time |
|---|---|---|
| 12 | Recall: `WHERE classification <= :maxClass AND (classification <= 1 OR user_id = :userId)` | 30 min |
| 13 | Store: tag with userId, enforce maxClass limit per role | 15 min |
| 14 | Sleep master extraction: full processing, confidentiality signal detection → class 2 | 30 min |
| 15 | Sleep user extraction: lightweight facts + preferences pass, class 1, tagged with userId | 30 min |
| 16 | Guest: skip DB write entirely (context window only, reset on full) | 10 min |
| 17 | Wake-up: master=full ABM, user=last-session summary, guest="Hi! How can I help?" | 30 min |
| 18 | SOUL.md: no-attribution rule + confidentiality signal instruction | 15 min |
| 19 | Tests | 15 min |

### Phase 3 — Profiles + polish (~2hr)

| Step | What | Time |
|---|---|---|
| 20 | `user_profile_{userId}.md` per user | 30 min |
| 21 | Session-start injects correct user profile | 15 min |
| 22 | SOUL.md: class 3 non-disclosure rule | 15 min |
| 23 | displayName in registry → dashboard + logs | 15 min |
| 24 | Document security model (classification = privacy, not enforcement) | 15 min |
| 25 | End-to-end test: master + user simultaneous | 30 min |

**Total: ~11hr. Phase 0 done. Phase 1 is the next milestone.**

## Schema (already done)

`user_id TEXT DEFAULT 'aksika'` added to: messages, extracted_memories, ingested_documents, entities. `extraction_watermarks` keyed by user_id (per-user sleep extraction). Migration defaults existing data to master's userId. Done in abmind repo.

## What stays shared

- Agent personality (SOUL.md, agent_notes.md)
- Skills (master only uses them via tools, but they're loaded once)
- Cron system (master's tasks, always delivered to master's main channel)
- Dashboard (master access only)
- Model/endpoint config

## Main channel ✅ DONE

Cron results, system notifications, and task reports always go to the master's main channel. Defined in .env:

```env
# Master's primary Telegram chatId — cron results, system notifications, task reports
MAIN_CHAT_ID=7773842843
```

Replaces `ALLOWED_USER_IDS` for delivery routing. Auth is handled by users.json. Never delivers cron results to non-master users.

## Migration

- `ALLOWED_USER_IDS` → `users.json` (if no users.json, ALLOWED_USER_IDS treated as all-master fallback)
- Existing memories: `user_id` already defaults to master's userId (done in abmind schema)
- Existing session keys (`telegram:123`) → mapped to userId on first message

## Deploy

`deploy.sh` never overwrites `config/users.json` if it exists (same pattern as .env). Guests approved at runtime persist across deploys.

## Security notes

- Classification is agent-level privacy, not OS-level enforcement. A master with bash can query the DB directly. Acceptable for family trust model.
- Class 3 non-disclosure relies on prompt instruction. A sufficiently clever prompt injection could bypass it. Defense: class 3 memories should also be encrypted at rest (#45) for true protection.
- User/guest with no tools cannot execute code, browse, or modify files. Pure conversation only.
- All user/guest messages scanned for injection (#127) before reaching the model.
