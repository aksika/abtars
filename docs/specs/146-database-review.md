# #146 Database Review — add user_id, drop dead tables, schema cleanup

**Date:** 2026-04-14
**Status:** Planned
**Priority:** MEDIUM

## Goal

Clean up abmind schema: drop dead tables, add `user_id` for multi-user prep, fix watermark PK.

## Table audit results

### DROP (dead — no reads or writes)

| Table | Reason |
|---|---|
| `compactions` | Nothing reads/writes. Compaction is in-memory only. Comment confirms: "Replaces the former compactions table" |
| `chat_backup` | Duplicate of `messages`. Only used in maintenance prune. Nobody reads from it |
| `sessions` | Only read for stats count. Sessions managed in-memory by bridge |
| `embeddings` | Old per-message embeddings. Replaced by `extracted_memories.embedding` inline BLOB |
| `memory_embeddings` | Separate embedding table, write path never built. Same as above — inline BLOB is used |
| `memory_entities` | Junction table, never populated. Replace with `entities TEXT` column on `extracted_memories` |

### KEEP + MODIFY

| Table | Changes |
|---|---|
| `messages` | Add `user_id TEXT DEFAULT 'aksika'` |
| `extracted_memories` | Add `user_id TEXT DEFAULT 'aksika'`, add `entities TEXT` |
| `ingested_documents` | Add `user_id TEXT DEFAULT 'aksika'` |
| `entities` | Add `user_id TEXT DEFAULT 'aksika'` (catalog of named things) |
| `extraction_watermarks` | Replace `chat_id INTEGER PK` with `user_id TEXT PK DEFAULT 'aksika'` |

### REMOVE FROM ABMIND SCHEMA (lives in agentbridge only)

| Table | Reason |
|---|---|
| `cron_entries` | Cron is a bridge concern, not memory. Duplicate — real one is in agentbridge `cron-db.ts` |

### KEEP AS-IS

| Table | Notes |
|---|---|
| `extracted_memories_fts` | FTS5 virtual table, triggers — working |
| `content_en_trigram` | FTS5 trigram search — working |
| `content_original_trigram` | FTS5 trigram search — working |
| `schema_version` | Migration tracking |

## Migration SQL (v14)

```sql
-- Drop dead tables
DROP TABLE IF EXISTS compactions;
DROP TABLE IF EXISTS chat_backup;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS embeddings;
DROP TABLE IF EXISTS memory_embeddings;
DROP TABLE IF EXISTS memory_entities;
DROP TABLE IF EXISTS cron_entries;

-- Add user_id to kept tables
ALTER TABLE messages ADD COLUMN user_id TEXT DEFAULT 'aksika';
ALTER TABLE extracted_memories ADD COLUMN user_id TEXT DEFAULT 'aksika';
ALTER TABLE extracted_memories ADD COLUMN entities TEXT;
ALTER TABLE ingested_documents ADD COLUMN user_id TEXT DEFAULT 'aksika';
ALTER TABLE entities ADD COLUMN user_id TEXT DEFAULT 'aksika';

-- Recreate extraction_watermarks with user_id PK
CREATE TABLE extraction_watermarks_new (
  user_id TEXT PRIMARY KEY DEFAULT 'aksika',
  last_processed_timestamp INTEGER NOT NULL
);
INSERT INTO extraction_watermarks_new (user_id, last_processed_timestamp)
  SELECT 'aksika', last_processed_timestamp FROM extraction_watermarks LIMIT 1;
DROP TABLE extraction_watermarks;
ALTER TABLE extraction_watermarks_new RENAME TO extraction_watermarks;
```

## Code changes

| File | Change |
|---|---|
| `memory-db.ts` | Update CREATE TABLE statements, remove dropped tables, bump to v14 |
| `sleep-data-access.ts` | `chat_id` → `user_id` for watermark reads/writes |
| `memory-editor.ts:216` | Remove `DELETE FROM embeddings` (table dropped) |
| `message-store.ts:31` | Remove `INSERT INTO chat_backup` |
| `maintenance-service.ts` | Remove chat_backup prune logic |
| `sleep-state-gatherer.ts:201` | Remove `sessionCount` stat (sessions table dropped) |
| `memory-manager.ts:385-394` | Remove memory_embeddings quantization code |

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | Write migration v14 in `memory-db.ts` | 10 min |
| 2 | Update CREATE TABLE statements for new DBs | 10 min |
| 3 | Update `sleep-data-access.ts` — watermark `chat_id` → `user_id` | 10 min |
| 4 | Remove dead code refs (chat_backup writes, embeddings deletes, session count, quantization) | 10 min |
| 5 | Type-check + tests | 10 min |
| **Total** | | **~50 min** |
