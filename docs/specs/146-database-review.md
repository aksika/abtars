# #146 Database Review — add user_id, drop dead tables, schema cleanup

**Date:** 2026-04-14
**Status:** Planned
**Priority:** MEDIUM

## Goal

Prepare the schema for multi-user (#67) and memory separation (#135). Add `user_id` now so no migration needed later. Clean up dead tables.

## Changes

### 1. Add `user_id TEXT DEFAULT 'aksika'` to all tables

| Table | Notes |
|---|---|
| messages | |
| extracted_memories | |
| embeddings | |
| ingested_documents | |
| chat_backup | |
| entities | |
| memory_entities | |
| memory_embeddings | |

### 2. Drop dead `compactions` table

Nothing reads or writes it. Compaction is in-memory only (#147). `consolidation-search.ts` comment confirms: "Replaces the former compactions table."

### 3. `extraction_watermarks` — PK change

Replace `chat_id INTEGER PRIMARY KEY` with `user_id TEXT PRIMARY KEY DEFAULT 'aksika'`. Watermark is per-user, not per-chat. A user's messages span multiple chats/platforms.

Update `SleepDataAccess` to use `user_id` instead of `chat_id` for watermark reads/writes.

### 4. Bump schema_version

### 5. Update CREATE TABLE statements for new DBs

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | ALTER TABLE × 8 — add `user_id` column | 5 min |
| 2 | Drop `compactions` table + index | 2 min |
| 3 | Recreate `extraction_watermarks` with `user_id` PK, migrate data | 5 min |
| 4 | Update `SleepDataAccess` — `chat_id` → `user_id` for watermarks | 10 min |
| 5 | Update CREATE TABLE statements in `memory-db.ts` | 5 min |
| 6 | Bump schema_version + migration function | 5 min |
| 7 | Type-check + tests | 5 min |
| **Total** | | **~35 min** |

## Migration SQL

```sql
-- Add user_id to all tables
ALTER TABLE messages ADD COLUMN user_id TEXT DEFAULT 'aksika';
ALTER TABLE extracted_memories ADD COLUMN user_id TEXT DEFAULT 'aksika';
ALTER TABLE embeddings ADD COLUMN user_id TEXT DEFAULT 'aksika';
ALTER TABLE ingested_documents ADD COLUMN user_id TEXT DEFAULT 'aksika';
ALTER TABLE chat_backup ADD COLUMN user_id TEXT DEFAULT 'aksika';
ALTER TABLE entities ADD COLUMN user_id TEXT DEFAULT 'aksika';
ALTER TABLE memory_entities ADD COLUMN user_id TEXT DEFAULT 'aksika';
ALTER TABLE memory_embeddings ADD COLUMN user_id TEXT DEFAULT 'aksika';

-- Drop dead table
DROP TABLE IF EXISTS compactions;

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
