# §4+ Database Maintenance

## WAL Checkpoint
```bash
sqlite3 ~/.agentbridge/memory/memory.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

## FTS5 Integrity

- `messages_fts` — status: **${FTS_MESSAGES}**
- `extracted_memories_fts` — status: **${FTS_EXTRACTED}**
- `extracted_memories_original_fts` — status: **${FTS_ORIGINAL}**

For each corrupt table:
```bash
sqlite3 ~/.agentbridge/memory/memory.db "INSERT INTO TABLE_NAME(TABLE_NAME) VALUES('rebuild');"
```

## Batch Embed

If NULL embeddings exist and `EMBEDDING_ENABLED=true`:
```bash
EMBEDDING_ENABLED=true agentbridge-embed
```

## Orphan Cleanup

- Delete orphaned FTS entries (rowid not in source table)
- Delete stale sessions (`is_active = 0` with old `last_activity_at`)

## Log Rotation Cleanup

Delete bridge log files older than 7 days:
```bash
find ~/.agentbridge/logs/ -name "bridge-*.log" -mtime +7 -delete
```

Respond with what you did (or "all healthy, nothing to do").
