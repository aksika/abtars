# #67 Multi-User Support

**Date:** 2026-04-14
**Status:** Planned
**Priority:** HIGH

## Goal

Multiple users interact with the same bridge instance. Identity-based routing, memory separation by classification, master priority.

## Roles

| Role | Source | Max classification | Tools | Priority |
|---|---|---|---|---|
| master | .env only | 2 | all | highest |
| user | .env only | 1 | all | normal |
| guest | runtime (/approve) | 0 (world only) | all | lowest |

Master and user roles can only be assigned via .env. Guests are approved at runtime and persisted to `~/.agentbridge/config/guests.json`.

## Auth config

```env
# Format: userId:role:telegramId[:discordId]
USERS=master:master:7773842843,adrika:user:8385860222
```

Replaces `ALLOWED_USER_IDS`. Both Telegram and Discord are closed by default — allowlist only.

## Pairing flow (guests)

1. Unknown person messages bot → bot replies "👋 To get access, ask the owner to run: `/approve`"
2. Master sends `/approve <platformId>` → person added as `guest`, persisted to `guests.json`
3. Guest can now chat. Sees only classification=0 (world) memories.
4. To promote: `/promote <userId> user` (runtime) or edit .env (permanent)

No pairing codes — master provides the platform ID directly. Simpler, no state to track.

## Memory visibility (Unix-style)

Uses existing `classification` column — no schema change for the column itself.

| Classification | Label | Visible to |
|---|---|---|
| 0 | World | everyone (master + user + guest) |
| 1 | Internal | master + user |
| 2 | Master | master only |
| 3 | Non-disclosed | nobody (encrypted at rest, future #45) |

Recall filter: `WHERE classification <= {roleMaxClassification}`

Store defaults:
- master: classification=1 (can store any level)
- user: classification=1 (can store 0 or 1)
- guest: classification=0 (world only)

**Security note:** Classification is agent-level privacy — it controls what the agent shows in recall. It is NOT OS-level enforcement. A user with bash tool access could query the DB directly. This is acceptable for the trust model (master + trusted friends). Document this.

## Transport

One transport session per userId. Direct API is stateless — multiple sessions are free.

### Priority queue

When multiple users have pending messages:
```
master messages processed first
user messages processed next
guest messages processed last
```

Implementation: priority field in the busy guard queue. Sort on drain.

## Session key

`{userId}:{platform}` — e.g. `master:telegram`, `adrika:telegram`

Replaces `telegram:{chatId}`. All downstream code uses userId.

## User registry

Parsed at startup from .env + guests.json. In-memory map:

```typescript
interface UserEntry {
  userId: string;
  role: "master" | "user" | "guest";
  displayName?: string;
  platforms: { telegram?: number; discord?: string };
}
```

Security gate: receives platform + platformId → looks up UserEntry → returns `{ userId, role }` or null (rejected).

## Commands

| Command | Who | What |
|---|---|---|
| `/approve <platformId>` | master | Add guest |
| `/promote <userId> user` | master | Upgrade guest to user (runtime) |
| `/revoke <userId>` | master | Remove guest |
| `/users` | master | List all users with roles |

## Delivery context

Track which platform each user last messaged from. Cron results, reminders, and system messages delivered to the user's last-active platform.

```typescript
// In user registry (runtime)
lastPlatform: "telegram" | "discord";
lastChatId: number | string;
```

## Phase 1 — Identity + routing + pairing (~5hr)

| Step | What | Time |
|---|---|---|
| 1 | Parse `USERS` env → user registry + load guests.json | 30 min |
| 2 | Security gate: platformId → userId + role lookup | 30 min |
| 3 | Pairing: unknown sender → reject with message. `/approve` adds guest | 45 min |
| 4 | Session key: `{userId}:{platform}` — update pipeline, adapters | 1 hr |
| 5 | Priority queue in busy guard — master > user > guest | 30 min |
| 6 | `/users`, `/promote`, `/revoke` commands | 30 min |
| 7 | Delivery context tracking (lastPlatform per user) | 15 min |
| 8 | Cron delivery: resolve userId → platform chatId | 30 min |
| 9 | Tests | 30 min |

## Phase 2 — Memory separation (~3hr)

| Step | What | Time |
|---|---|---|
| 10 | `user_id` column on messages table | 15 min |
| 11 | `user_id` column on extracted_memories table | 15 min |
| 12 | Recall: filter by `classification <= roleMax` + `user_id` scoping | 45 min |
| 13 | Store: tag with userId + enforce classification limits per role | 30 min |
| 14 | Wake-up: built per userId (only their memories) | 30 min |
| 15 | Migration: existing data → `user_id = "master"` | 15 min |
| 16 | Tests | 30 min |

## Phase 3 — Per-user profiles + polish (~2hr)

| Step | What | Time |
|---|---|---|
| 17 | `user_profile_{userId}.md` — per-user profile in core/ | 30 min |
| 18 | Session-start injects correct user profile | 15 min |
| 19 | displayName in user registry → dashboard + logs | 15 min |
| 20 | Document classification security model | 15 min |
| 21 | Update SOUL.md — agent knows about multi-user | 15 min |
| 22 | End-to-end test: master + guest simultaneous | 30 min |

**Total: ~10hr across 3 phases. Phase 1 alone is functional.**

## What stays shared

- Agent personality (SOUL.md, agent_notes.md)
- Skills
- Transport (one ollama, multiple sessions)
- Cron system (tasks belong to a userId)
- Dashboard
- Tools (all roles get all tools for now)

## What's per-user

- Session (isolated context per userId)
- Memory recall (filtered by classification + userId)
- User profile (Phase 3)
- Wake-up context
- Delivery platform preference

## Migration

- `ALLOWED_USER_IDS` → `USERS` (new format, old var ignored if USERS present)
- Existing memories: `user_id = "master"` backfill
- Existing cron entries: `chat_id` stays, delivery resolves via user registry
- Existing session keys (`telegram:123`) → mapped to new format on first message

## Reference

OpenClaw uses a "one operator per gateway" model — no multi-user within a single instance. AB takes a different approach: shared instance with classification-based privacy. OC patterns adopted: pairing flow concept (simplified to /approve), delivery context tracking, displayName in sessions.
