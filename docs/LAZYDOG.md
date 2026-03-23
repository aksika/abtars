# Lazydog — Memory System Quick Commands

All commands run from PowerShell. They use WSL because npm/node aren't on the Windows PATH.

## Run Tests

```powershell
# All tests
wsl bash -c "cd /mnt/c/Users/qakosal/workspace/openclaw/agentbridge && npx vitest --run"

# Just memory tests
wsl bash -c "cd /mnt/c/Users/qakosal/workspace/openclaw/agentbridge && npx vitest --run src/components/memory-manager.test.ts src/components/memory-index.test.ts src/components/memory-config.test.ts src/components/memory-e2e.test.ts src/components/memory-properties.test.ts"

# Just integration + e2e
wsl bash -c "cd /mnt/c/Users/qakosal/workspace/openclaw/agentbridge && npx vitest --run src/components/session-manager.test.ts src/components/memory-e2e.test.ts"

# Single test file
wsl bash -c "cd /mnt/c/Users/qakosal/workspace/openclaw/agentbridge && npx vitest --run src/components/memory-properties.test.ts"
```

## Inspect the SQLite Database

```powershell
# Open the memory DB (default location)
wsl bash -c "sqlite3 ~/.agentbridge/memory/memory.db"

# Inside sqlite3:
.tables                                          -- list all tables
SELECT * FROM sessions;                          -- active/inactive sessions
SELECT COUNT(*) FROM messages;                   -- total indexed messages
SELECT * FROM messages ORDER BY timestamp DESC LIMIT 10;  -- recent messages
SELECT * FROM compactions ORDER BY timestamp DESC LIMIT 5; -- compaction summaries
SELECT * FROM messages_fts WHERE messages_fts MATCH 'keyword'; -- FTS search
.quit
```

## Check Transcript Files

```powershell
# List all transcript files
wsl bash -c "find ~/.agentbridge/memory/transcripts -name '*.jsonl' -ls"

# Read a specific transcript (last 5 lines)
wsl bash -c "tail -5 ~/.agentbridge/memory/transcripts/<chatId>/<sessionId>.jsonl"

# Pretty-print a transcript
wsl bash -c "cat ~/.agentbridge/memory/transcripts/<chatId>/<sessionId>.jsonl | python3 -m json.tool --json-lines"

# Count messages per chat
wsl bash -c "for f in ~/.agentbridge/memory/transcripts/*/*.jsonl; do echo \"\$f: \$(wc -l < \$f) lines\"; done"
```

## Check Memory Archive (Compaction Files)

```powershell
# List daily/weekly/monthly/yearly summaries
wsl bash -c "find ~/.agentbridge/memory/memory -name '*.md' -ls"

# Read a daily summary
wsl bash -c "cat ~/.agentbridge/memory/memory/daily/<chatId>/<date>.md"
```

## Check Scratchpad & Core Facts

```powershell
# Read scratchpad for a chat
wsl bash -c "cat ~/.agentbridge/memory/scratchpads/<chatId>/scratchpad.md"

# Read user core facts
wsl bash -c "cat ~/.agentbridge/memory/core/<chatId>/user_core_facts.md"
```

## Disk Usage

```powershell
# Total memory layer disk usage
wsl bash -c "du -sh ~/.agentbridge/memory/"

# Breakdown by component
wsl bash -c "du -sh ~/.agentbridge/memory/transcripts/ ~/.agentbridge/memory/memory.db ~/.agentbridge/memory/memory/ ~/.agentbridge/memory/scratchpads/ ~/.agentbridge/memory/core/ 2>/dev/null"
```

## Build & Type Check

```powershell
wsl bash -c "cd /mnt/c/Users/qakosal/workspace/openclaw/agentbridge && npx tsc --noEmit"
```

## Git

```powershell
git add -A; git commit -m "test: add memory system integration, e2e, and property tests"; git push
```
