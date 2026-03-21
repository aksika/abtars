# Memory System — Update Journal

## 2026-03-21: Cascade delete for GC + JSONL sync

**Problem:** Sleep cycle GC (Step 1 + Step 2) used raw `DELETE FROM messages` SQL, which only removed rows from the DB. The JSONL transcript — append-only, never pruned — kept growing. After GC, the startup drift check (`checkTranscriptDbDrift`) warned about JSONL vs DB count mismatch, which was a false alarm caused by the one-sided delete.

**Solution:**
- Made `cascadeDelete()` public on MemoryManager. It already handles full cleanup: DB rows, JSONL transcript lines (matched by timestamp:content), embeddings, FTS5 (via trigger).
- Added `--delete-ids <ids> --chat-id <id>` mode to `agentbridge-store` CLI, calling `cascadeDelete()`.
- Updated `sleeping_prompt.md` (deployed + source): Step 1 and Step 2 now use `agentbridge-store --delete-ids` instead of raw SQL.
- Drift check reverted to bidirectional warning — JSONL and DB should stay in sync now.
- Cleaned up duplicate `case` clauses in `agentbridge-store` parseArgs.
- Added 5 tests: parseArgs, DB removal, JSONL removal, empty IDs no-op, non-existent IDs no-op.

**Files changed:** `memory-manager.ts`, `agentbridge-store.ts`, `agentbridge-store.test.ts`, `sleeping_prompt.md` (persona + deployed), `Memory.asbuilt.md`

---

## 2026-03-20: Prompt injection gate on agentbridge-store

**Problem:** Any content with trust < 5 (web-sourced tweets, A2A messages) could be stored to memory without scanning for prompt injection patterns.

**Solution:**
- Wired `prompt-scanner.ts` (22 regex patterns + invisible unicode detection) into `agentbridge-store` for all trust < 5 content.
- On hit: store blocked, JSON error returned, attempt logged to `~/.agentbridge/logs/prompt_injection.log`.
- Baseline audit: all 42 existing memories scanned (regex + LLM) — zero hits. Risk is future-facing (tweet ingestion pipeline).

**Files changed:** `agentbridge-store.ts`, `Memory.asbuilt.md`

---

## 2026-03-20: GraphQL chronological timeline

**Problem:** rettiwt-api guest `user.timeline()` returns all-time top tweets by engagement, not recent. Daily feed was getting stale/irrelevant content (e.g. 1 tweet instead of 12+).

**Solution:**
- Switched to GraphQL `UserTweets` endpoint (`E3opETHurmVJflFsUBVuUQ`) with cookie auth for chronological results.
- Guest fallback via rettiwt-api retained for resilience.
- Raw JSON output to `~/.agentbridge/twitterX/output/tweets-YYYY-MM-DD.json`, `--output` flag added.

**Files changed:** `agentbridge-tweet.ts`

### 2026-03-21 — Memory Refactor Implementation (R5, R1, R4, R6)

**R5: Dead code deletion** (`64ce171`)
- Deleted 9 files: context-assembler, context-window-monitor, intent-detector, recall-fallback-pipeline, memory-search-tool (all + tests)
- Cleaned memory-manager.ts: removed imports, fields, init block, recallForPrompt(), assembleContext(), initSearchTool(), memorySearch(), getMemorySearchTool()
- Removed initSearchTool() call from main.ts
- Net: -3326 lines, 636→614 tests

**R1: SQLite single source** (`205a3b3`)
- messages.content now stores raw content WITH emojis
- FTS5 trigger strips emojis via strip_emojis() custom SQLite function (content=messages means search returns raw, index is emoji-free)
- Eliminated JSONL writes, drift check, JSONL cascade cleanup
- Deleted transcript-writer.ts, transcript-parser.ts + tests
- Simplified: recordMessage, cascadeDelete, enforceDiskBudget, loadRecentMessages, checkAutoCompact
- Net: -922 lines

**R4: chat_backup debug-only** (`4ed509d`)
- chat_backup INSERT gated behind DEBUG_MODE=true|1 env var
- Table and pruneBackup remain for existing data

**R6: Immediate emotion propagation** (`77edc03`)
- updateEmotionByPlatformId now propagates score to extracted_memories via source_message_ids LIKE match
- Sleep harvest becomes verbal-only

**R3: Sleep cycle restructure** (`d215b39`)
- New 10-step order: retrospective → feedback → todo → GC (7 substeps) → cron → topics → fitness → merge → consolidation → report
- Retrospective runs FIRST (before GC deletes messages), writes retro file + updates agent_notes
- Emotion harvest verbal-only (emoji reactions handled at runtime)
- Message flush step deletes >24h messages after extraction
- JSONL references replaced with DB queries
- Added LAST_SLEEP_TS, CURRENT_TS template variables; removed TRANSCRIPT_PATHS
- Added lastSleepTimestamp to StateSnapshot

**R2: Recall cascade refactor** (`8c208de`)
- 5-stage extracted-first cascade: extracted EN → extracted original → messages FTS5 OR → consolidation → messages LIKE
- Short-circuit: ≥10 extracted results skips stages 3-5
- Removed: strict AND, substring LIKE ×2, chat_backup LIKE
- DB opened read-write for Darwinism bumps
