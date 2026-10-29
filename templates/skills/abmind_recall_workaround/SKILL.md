---
name: abmind_recall_workaround
description: Fallback when abmind recall / the abmind_recall tool fails — read memories directly from the SQLite DB
user-invocable: false
---

# abmind recall — direct DB workaround

When `abmind recall` errors out (daemon down, embedding provider missing, tool not registered), memories can still be read **directly** from the memory database. Read-only sqlite3 queries — macOS ships `sqlite3`. Durables live in `long_term_memories`; do not query any other table — anything else is frozen, unread for serving, or removed.

DB path (Molty): `~/.abmind/memory/memory.db`

**Rules**
- Always open read-only (no write transactions from a skill)
- Always filter `encrypted = 0` — encrypted rows store ciphertext and are unreadable directly
- SECRET memories (classification = 3) are always sealed/encrypted — they never appear in direct reads
- Only current rows: `valid_to IS NULL` skips superseded revisions
- Timestamps are epoch milliseconds → `datetime(timestamp/1000,'unixepoch','localtime')`

## Recent memories

```bash
sqlite3 -header -column ~/.abmind/memory/memory.db "SELECT id, memory_type, datetime(created_at/1000,'unixepoch','localtime') AS created, substr(content,1,200) AS content FROM long_term_memories WHERE encrypted = 0 AND valid_to IS NULL ORDER BY created_at DESC LIMIT 20;"
```

## Keyword search (memories, not raw messages)

```bash
sqlite3 -header -column ~/.abmind/memory/memory.db "SELECT id, memory_type, datetime(created_at/1000,'unixepoch','localtime') AS created, substr(content,1,200) AS content FROM long_term_memories WHERE encrypted = 0 AND valid_to IS NULL AND (content LIKE '%keyword%' OR content_original LIKE '%keyword%') ORDER BY created_at DESC LIMIT 20;"
```

- Search `content` and original-language `content_original`
- Use `%` wildcards for partial words (LIKE, not FTS)

## Memories from the last N hours

```bash
sqlite3 -header -column ~/.abmind/memory/memory.db "SELECT id, memory_type, substr(content,1,200) AS content FROM long_term_memories WHERE encrypted = 0 AND valid_to IS NULL AND created_at > (strftime('%s','now') - 86400) * 1000 ORDER BY created_at DESC LIMIT 20;"
```

(86400 = 24h; use 3600 for 1h, 172800 for 48h)

## Useful columns

| Column | Meaning |
|---|---|
| `content` | Durable content |
| `content_original` | As-spoken content |
| `memory_type` | fact / preference / decision / event |
| `classification` | 0 group, 1 personal, 2 confidential (3 = SECRET, sealed) |
| `created_at` | epoch ms |
| `authority` | user_statement / confirmed_decision / agent_proposal / inference |


## When to use
- `abmind recall` or `abmind_recall` tool errors or returns nothing
- Need memories while the daemon/embedding provider is down
- Debugging what the recall tool would have found

## When NOT to use
- Raw conversation read-back → `read-messages` skill (`abmind messages`)
- Normal recall flow → `memory-search` skill (`abmind recall`)