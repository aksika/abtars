# Lazydog — Quick Commands

## Tests

```bash
npx vitest run --silent                    # all tests
npx vitest run src/components/recall-engine.test.ts  # specific file
npm run typecheck                          # type check
```

## Build & Deploy

```bash
npm run build
./scripts/deploy.sh          # full deploy
./scripts/deploy.sh --quick  # skip build + tmux restart
```

## Memory Search (agentbridge-recall)

```bash
# Basic search
agentbridge-recall --translated "puppy" --chat-id 7773842843

# With original language keyword
agentbridge-recall --translated "puppy" --original "kiskutya" --chat-id 7773842843

# Run specific stages only (dashboard investigation)
agentbridge-recall --translated "puppy" --chat-id 7773842843 --stages S1,S3

# Se embedding search only
EMBEDDING_ENABLED=true agentbridge-recall --translated "puppy" --chat-id 7773842843 --stages Se

# Compare FTS5 vs embedding
EMBEDDING_ENABLED=true agentbridge-recall --translated "dog" --chat-id 7773842843 --stages S1,Se
```

Stages: S1 (en FTS5), S2 (original FTS5), S3 (LIKE), Se (embedding), S4 (msg FTS5), S5 (msg LIKE), S6 (consolidation), S7 (fallback)

## Embeddings

```bash
# Setup (one-time)
./scripts/setup-embeddings.sh

# Batch embed all memories
EMBEDDING_ENABLED=true agentbridge-embed

# Check ollama status
curl -s http://localhost:11434/api/tags | python3 -m json.tool
```

## SQLite Database

```bash
sqlite3 ~/.agentbridge/memory/memory.db

# Inside sqlite3:
.tables
SELECT COUNT(*) FROM messages;
SELECT COUNT(*) FROM extracted_memories;
SELECT COUNT(*) FROM extracted_memories WHERE embedding IS NOT NULL;
SELECT id, substr(content_en,1,80) FROM extracted_memories ORDER BY id DESC LIMIT 10;
SELECT * FROM messages_fts WHERE messages_fts MATCH 'keyword';
SELECT * FROM extracted_memories_fts WHERE content_en MATCH 'keyword';
SELECT id, fire_at, message, paused FROM cron_entries;
.quit
```

## Health Check

```bash
~/.agentbridge/scripts/doctor.sh           # diagnose
~/.agentbridge/scripts/doctor.sh --fix     # safe fixes
~/.agentbridge/scripts/doctor.sh --fix-full  # + FTS rebuild, WAL checkpoint
```

## Bridge Control

```bash
~/.agentbridge/agentbridge.sh              # start (discord default)
~/.agentbridge/agentbridge.sh --telegram   # telegram only
~/.agentbridge/agentbridge.sh --all --web  # both + dashboard
~/.agentbridge/agentbridge.sh stop         # stop
```

## Disk Usage

```bash
du -sh ~/.agentbridge/memory/
du -sh ~/.agentbridge/memory/memory.db
du -sh ~/.agentbridge/logs/
```
