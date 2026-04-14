# #150 Sleep Pipeline + Memory Layer: chatId → userId

**Date:** 2026-04-15
**Status:** Planned
**Priority:** HIGH
**Depends on:** #146 (done — user_id in schema), #67 Phase 0 (done — users.json)

## Goal

Eliminate `chatId` from the memory layer entirely. Every memory operation uses `userId`. The bridge maps `platformId → userId` at the boundary.

## Scope

Both repos: abmind (memory layer) + agentbridge (callers).

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | `RecallParams`: `chatId` → `userId` | 10 min |
| 2 | `InstantStoreParams`: `chatId` → `userId` | 10 min |
| 3 | `MemoryBackend` interface + implementation: all methods use `userId` | 15 min |
| 4 | `SleepDataAccess`: all queries filter by `user_id` | 15 min |
| 5 | Sleep pipeline functions (`readMessages`, `extractDaily`): `chatId` → `userId` | 10 min |
| 6 | MCP server: pass `userId` properly to backend | 5 min |
| 7 | CLI commands (recall, store, edit): `--chat-id` → `--user-id` (keep `--chat-id` as alias) | 10 min |
| 8 | agentbridge callers: update all `chatId` → `userId` in memory calls | 15 min |
| 9 | Tests | 15 min |
| **Total** | | **~2 hr** |

## What changes

### abmind

- `RecallParams.chatId` → `RecallParams.userId`
- `InstantStoreParams.chatId` → `InstantStoreParams.userId`
- `MemoryBackend.recall(params)` — params use userId
- `MemoryBackend.instantStore(params)` — params use userId
- `MemoryBackend.cascadeDelete(messageIds, chatId)` → `(messageIds, userId)`
- `SleepDataAccess.resolveChatId()` → `resolveUserId()`
- `SleepDataAccess.getExtractionWatermark(chatId)` → `(userId)`
- `SleepDataAccess.getFirstMessageAfter(chatId)` → `(userId)`
- `readMessages(db, chatId, watermarkTs)` → `(db, userId, watermarkTs)`
- `readMessagesByDateRange(db, chatId, ...)` → `(db, userId, ...)`
- `extractDaily(db, chatId, ...)` → `(db, userId, ...)`
- MCP server: `chatId: 0` → `userId: uid`
- CLI: `--chat-id` aliased to `--user-id`, new flag is `--user-id`
- All SQL queries: `WHERE chat_id = ?` → `WHERE user_id = ?` in memory-scoped tables

### agentbridge

- `recordMessage({ chatId })` → `recordMessage({ userId })`
- `memory.getStats(chatId)` → `memory.getStats(userId)`
- Sleep orchestrator: passes `userId` instead of `chatId`
- Message pipeline: resolves `userId` from user registry, passes to memory

## SQL changes

```sql
-- Before
SELECT ... FROM messages WHERE chat_id = ?
SELECT ... FROM extracted_memories WHERE chat_id = ?

-- After
SELECT ... FROM messages WHERE user_id = ?
SELECT ... FROM extracted_memories WHERE user_id = ?
```

`chat_id` column stays in the schema (platform routing) but is no longer used for memory scoping.
