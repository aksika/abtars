# Implementation Plan: Local Memory

## Overview

Incrementally build the local-memory layer for agentbridge: starting with core types and config, then transcript I/O, SQLite persistence, FTS5 search, optional vector search, compaction, sleep-cycle consolidation, context assembly, scratchpad/facts management, and finally wiring everything into SessionManager and main.ts. Each task builds on the previous, with property-based tests integrated close to the implementation they validate.

## Tasks

- [x] 1. Define core types and MemoryConfig
  - [x] 1.1 Create `MessageRecord` type and `MemoryTier` / `CompactedMemory` / `StoredSession` types
    - Create `agentbridge/src/types/memory.ts` with `MessageRecord`, `MemoryTier`, `CompactedMemory`, `StoredSession`, `SearchResult`, `VectorSearchResult`, `SearchOptions`, `AssembledContext` types
    - Export from `agentbridge/src/types/index.ts`
    - _Requirements: 2.1, 11.1_

  - [x] 1.2 Implement `MemoryConfig` type and `loadMemoryConfig()` parser
    - Create `agentbridge/src/components/memory-config.ts`
    - Define `MemoryConfig` type with all fields from design (memoryEnabled, memoryDir, maxMessagesPerChat, diskBudgetBytes, vectorEnabled, stalenessThresholdMs, restoreMessageCount, compactOnReset, autoCompactThreshold, contextBudget)
    - Implement `loadMemoryConfig()` that reads from `process.env` with defaults, validates values, logs warnings for invalid values, falls back to defaults
    - Use existing `parseBooleanEnv` / `parseNumberEnv` patterns from `config.ts`
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ]* 1.3 Write property test for configuration parsing
    - **Property 16: Configuration Parsing**
    - Generate random valid env var values for all MEMORY_* variables, parse via `loadMemoryConfig()`, verify matching `MemoryConfig` fields. For invalid values, verify fallback to defaults.
    - **Validates: Requirements 7.1, 7.4**

- [x] 2. Implement TranscriptWriter and TranscriptParser
  - [x] 2.1 Implement `TranscriptWriter`
    - Create `agentbridge/src/components/transcript-writer.ts`
    - `append(record: MessageRecord): void` — serialize record as single JSON line, `appendFileSync` to `{baseDir}/transcripts/{chatId}/{sessionId}.jsonl`
    - `getPath(chatId, sessionId): string` — return the file path
    - Create directories with `mkdirSync({ recursive: true })` on first write
    - Wrap in try/catch, log errors, never throw
    - _Requirements: 2.1, 2.2, 2.3, 2.6, 11.1_

  - [x] 2.2 Implement `TranscriptParser`
    - Create `agentbridge/src/components/transcript-parser.ts`
    - `parse(filePath: string): MessageRecord[]` — read file, split on `\n`, parse each line as JSON, skip malformed lines with warning log
    - `parseTail(filePath: string, count: number): MessageRecord[]` — parse full file, return last `count` entries
    - _Requirements: 2.4, 2.5, 11.2, 11.4_

  - [ ]* 2.3 Write property test for transcript serialization round-trip
    - **Property 4: Transcript Serialization Round-Trip**
    - Generate random `MessageRecord[]` arrays (arbitrary role, content, timestamp, chatId, sessionId), write via `TranscriptWriter.append()`, read via `TranscriptParser.parse()`, assert deep equality in same order.
    - **Validates: Requirements 2.1, 2.2, 2.4, 2.5, 11.1, 11.2, 11.3**

  - [ ]* 2.4 Write property test for transcript file path structure
    - **Property 5: Transcript File Path Structure**
    - For any chatId (number) and sessionId (string), verify `TranscriptWriter.getPath()` returns `{baseDir}/transcripts/{chatId}/{sessionId}.jsonl`.
    - **Validates: Requirements 2.3**

  - [ ]* 2.5 Write property test for malformed JSONL handling
    - **Property 18: Malformed JSONL Lines Are Skipped**
    - Generate JSONL files with a mix of valid JSON lines and random non-JSON strings, parse via `TranscriptParser.parse()`, verify only valid `MessageRecord` objects returned in original order.
    - **Validates: Requirements 11.4**

  - [ ]* 2.6 Write property test for parseTail returning most recent N messages
    - **Property 17: Restore Loads Most Recent N Messages**
    - For any transcript with M messages and restore count N, verify `parseTail()` returns `min(M, N)` messages that are the last entries in chronological order.
    - **Validates: Requirements 8.2**

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement SQLite schema and MemoryIndex (FTS5)
  - [x] 4.1 Create SQLite database initialization
    - Create `agentbridge/src/components/memory-db.ts`
    - Implement `initializeDatabase(dbPath: string): BetterSqlite3.Database` that opens/creates the SQLite database and runs all `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX` / `CREATE VIRTUAL TABLE` / `CREATE TRIGGER` statements from the design (sessions, messages, messages_fts, embeddings, compactions tables)
    - Create directories with `mkdirSync({ recursive: true })` if needed
    - _Requirements: 1.5_

  - [x] 4.2 Implement `MemoryIndex` class (FTS5 full-text search)
    - Create `agentbridge/src/components/memory-index.ts`
    - `initialize()` — create FTS5 table if not exists (handled by db init, but verify)
    - `index(record: MessageRecord): void` — insert into `messages` table (FTS trigger auto-indexes)
    - `search(query, opts?)` — query `messages_fts` with BM25 ranking, support chatId filter, date range filter, limit
    - `removeSession(chatId, sessionId)` — delete from `messages` where matching (triggers auto-remove from FTS)
    - `prune(chatId, maxMessages)` — delete oldest messages beyond limit for a chat
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 5.2_

  - [ ]* 4.3 Write property test for indexed messages are searchable
    - **Property 6: Indexed Messages Are Searchable**
    - Record a `MessageRecord` via `MemoryIndex.index()`, search for a distinctive word from its content, verify the result contains that message.
    - **Validates: Requirements 3.1**

  - [ ]* 4.4 Write property test for BM25 ordering
    - **Property 7: Search Results Ordered by BM25 Score**
    - Index multiple messages, search with a query returning multiple results, verify results ordered by descending BM25 score.
    - **Validates: Requirements 3.2**

  - [ ]* 4.5 Write property test for search filters
    - **Property 8: Search Filters Are Respected**
    - Index messages with varying chatIds and timestamps, search with chatId filter and date range, verify all results match the filter criteria.
    - **Validates: Requirements 3.3, 3.4**

  - [ ]* 4.6 Write property test for session deletion removes index entries
    - **Property 9: Session Deletion Removes Index Entries**
    - Index messages for a session, call `removeSession()`, verify search returns zero results for that session's content.
    - **Validates: Requirements 3.6**

  - [ ]* 4.7 Write property test for pruning preserves most recent messages
    - **Property 13: Pruning Preserves Most Recent Messages**
    - Index N messages for a chat, prune with limit L < N, verify exactly L messages remain and they are the L with highest timestamps.
    - **Validates: Requirements 5.2, 5.3**

- [x] 5. Implement session persistence in SQLite
  - [x] 5.1 Implement session CRUD operations in MemoryManager (partial)
    - Create `agentbridge/src/components/memory-manager.ts` (initial skeleton)
    - Implement `persistSession(session: SessionState): void` — insert/upsert into `sessions` table
    - Implement `touchSession(chatId, sessionId): void` — update `lastActivityAt`
    - Implement `deactivateSession(chatId, sessionId): void` — set `is_active = 0`
    - Implement `restoreSessions(stalenessMs): StoredSession[]` — query active sessions within threshold
    - All methods wrapped in try/catch with logging
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6_

  - [ ]* 5.2 Write property test for session persistence round-trip
    - **Property 1: Session Persistence Round-Trip**
    - Generate random `SessionState` objects, persist via `persistSession()`, query DB, verify identical fields. Call `touchSession()` with new timestamp, re-query, verify updated `lastActivityAt`.
    - **Validates: Requirements 1.1, 1.2**

  - [ ]* 5.3 Write property test for session restore respects staleness threshold
    - **Property 2: Session Restore Respects Staleness Threshold**
    - Insert sessions with varying `lastActivityAt`, call `restoreSessions(threshold)`, verify only sessions within threshold are returned.
    - **Validates: Requirements 1.3, 8.1**

  - [ ]* 5.4 Write property test for session reset marks inactive
    - **Property 3: Session Reset Marks Inactive**
    - Persist an active session, call `deactivateSession()`, verify `is_active = 0` in DB and session does not appear in `restoreSessions()`.
    - **Validates: Requirements 1.4**

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement optional VectorIndex and EmbeddingProvider
  - [x] 7.1 Implement `EmbeddingProvider`
    - Create `agentbridge/src/components/embedding-provider.ts`
    - Constructor takes optional model name (default `"Xenova/all-MiniLM-L6-v2"`)
    - `initialize(): Promise<void>` — load ONNX model via `@xenova/transformers`
    - `embed(text, db): Promise<Float32Array>` — compute SHA-256 hash of text, check `embeddings` cache in SQLite, return cached vector if found, otherwise compute embedding and store in cache
    - `isReady` getter
    - Wrap in try/catch, log errors on model load failure
    - _Requirements: 4.1, 4.7_

  - [x] 7.2 Implement `VectorIndex`
    - Create `agentbridge/src/components/vector-index.ts`
    - `initialize()` — ensure embeddings table exists
    - `index(messageId, content): Promise<void>` — compute embedding via `EmbeddingProvider`, store in `embeddings` table
    - `search(query, opts?): Promise<VectorSearchResult[]>` — embed query, compute cosine similarity against stored vectors in JS, return sorted by descending similarity
    - `removeSession(chatId, sessionId)` — delete embeddings for messages in that session
    - Implement cosine similarity helper function
    - _Requirements: 4.2, 4.3_

  - [x] 7.3 Implement reciprocal rank fusion in MemoryManager
    - Add `hybridSearch(query, opts)` method to MemoryManager that combines FTS results from `MemoryIndex.search()` with vector results from `VectorIndex.search()` using reciprocal rank fusion formula: `score = 1/(k + rank_fts) + 1/(k + rank_vector)`
    - When vector search is disabled, return FTS results only
    - _Requirements: 4.4, 4.5_

  - [ ]* 7.4 Write property test for vector search ordering
    - **Property 10: Vector Search Ordered by Cosine Similarity**
    - Embed multiple messages, search, verify results ordered by descending cosine similarity.
    - **Validates: Requirements 4.2, 4.3**

  - [ ]* 7.5 Write property test for reciprocal rank fusion correctness
    - **Property 11: Reciprocal Rank Fusion Correctness**
    - Generate two random ranked lists, compute fusion, verify each result's score matches `1/(k + rank_fts) + 1/(k + rank_vector)` and output is sorted by descending fused score.
    - **Validates: Requirements 4.4**

  - [ ]* 7.6 Write property test for embedding cache consistency
    - **Property 12: Embedding Cache Consistency**
    - Call `embed(text)` twice with same text, verify identical vectors and second call uses cache. Modify text by one character, verify fresh embedding computed.
    - **Validates: Requirements 4.7**

- [x] 8. Implement CompactionEngine
  - [x] 8.1 Implement `CompactionEngine`
    - Create `agentbridge/src/components/compaction-engine.ts`
    - `compact(params)` — load transcript via `TranscriptParser`, send to LLM with daily compaction prompt, persist summary as `{baseDir}/memory/daily/{chatId}/YYYY-MM-DD.md`, insert row into `compactions` table, index compaction in `messages` table with `role = 'compaction'`
    - `consolidate(params)` — read source files, send to LLM with tier-appropriate prompt, write consolidated file, delete source files, update DB
    - `getCompactions(chatId, opts?)` — query `compactions` table
    - Handle multiple compactions on same day by appending to existing daily file
    - Wrap LLM calls in try/catch, return null on failure
    - _Requirements: 10.1, 10.2, 10.3, 10.5, 10.6, 10.7_

  - [ ]* 8.2 Write property test for compaction persistence round-trip
    - **Property 19: Compaction Persistence Round-Trip**
    - Generate random summary strings, compact with mock LLM, verify `getCompactions()` returns matching `CompactedMemory` with correct summary, chatId, sessionId, tier.
    - **Validates: Requirements 10.1, 10.2, 10.3**

  - [ ]* 8.3 Write property test for daily compaction file written to disk
    - **Property 20: Daily Compaction File Written to Disk**
    - After successful daily compaction, verify markdown file exists at `{baseDir}/memory/daily/{chatId}/YYYY-MM-DD.md` containing the summary text.
    - **Validates: Requirements 10.2**

  - [ ]* 8.4 Write property test for compaction is searchable via FTS
    - **Property 23: Compaction Is Searchable via FTS**
    - Persist a compaction summary, search for a distinctive word from it via `MemoryIndex.search()`, verify result found.
    - **Validates: Requirements 10.6**

- [x] 9. Implement SleepCycleRunner (hierarchical consolidation)
  - [x] 9.1 Implement `SleepCycleRunner`
    - Create `agentbridge/src/components/sleep-cycle-runner.ts`
    - `runPendingConsolidations(params)` — check daily→weekly (7+ daily files in same ISO week), weekly→monthly (4+ weekly in same month), monthly→yearly (12+ monthly in same year), run each via `CompactionEngine.consolidate()`
    - Private methods: `needsWeeklyRollup()`, `needsMonthlyRollup()`, `needsYearlyRollup()` — scan filesystem for source files, group by time period, check thresholds
    - During yearly consolidation, extract permanent user facts and append/merge to `user_core_facts.md`
    - On LLM failure, log error, retain source files, retry on next session start
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8_

  - [ ]* 9.2 Write property test for consolidation reduces file count
    - **Property 21: Consolidation Reduces File Count**
    - Create N daily files (N ≥ 7) within same ISO week, run weekly consolidation, verify exactly 1 weekly file exists and N source dailies deleted. Same for weekly→monthly (4+) and monthly→yearly (12+).
    - **Validates: Requirements 12.2, 12.3, 12.4**

  - [ ]* 9.3 Write property test for consolidation preserves information
    - **Property 22: Consolidation Preserves Information**
    - After consolidation, verify resulting summary file is non-empty and corresponding SQLite row exists with correct tier, chatId, and non-empty summary.
    - **Validates: Requirements 12.5**

- [x] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement Scratchpad and UserCoreFacts file management
  - [x] 11.1 Implement scratchpad read/write in MemoryManager
    - Add `readScratchpad(chatId): string` — read `{baseDir}/scratchpads/{chatId}/scratchpad.md`, create empty file if not exists, return content
    - Add `writeScratchpad(chatId, content): void` — write content to scratchpad file, create directories if needed
    - Wrap in try/catch, log errors, return empty string on read failure
    - _Requirements: 13.1, 13.5, 13.6_

  - [x] 11.2 Implement UserCoreFacts read/write in MemoryManager
    - Add `readUserCoreFacts(chatId): string` — read `{baseDir}/core/{chatId}/user_core_facts.md`, create empty file if not exists
    - Wrap in try/catch, log errors, return empty string on failure
    - _Requirements: 14.1, 14.5, 14.6_

  - [ ]* 11.3 Write property test for scratchpad persistence round-trip
    - **Property 24: Scratchpad Persistence Round-Trip**
    - Generate random non-empty strings, write via `writeScratchpad()`, read via `readScratchpad()`, verify identical content. Verify scratchpad survives simulated session reset (file persists).
    - **Validates: Requirements 13.1, 13.5**

- [x] 12. Implement ContextAssembler
  - [x] 12.1 Implement `ContextAssembler`
    - Create `agentbridge/src/components/context-assembler.ts`
    - `assemble(params): AssembledContext` — build context in priority order: (1) Soul + UserCoreFacts, (2) Scratchpad, (3) Recalled memories from hybrid search, (4) Working memory (last N raw messages), (5) User input
    - Each tier capped at its configured token budget using `chars / 4` heuristic
    - Working memory truncates oldest messages when over budget
    - Recalled memories capped at top-K results (default 3) within budget
    - Return `AssembledContext` with `text` and `usage` breakdown
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_

  - [ ]* 12.2 Write property test for context assembly respects token budgets
    - **Property 26: Context Assembly Respects Token Budgets**
    - Generate context with varying content sizes, verify each tier's token usage ≤ its configured budget and total equals sum of all tier usages.
    - **Validates: Requirements 15.2, 15.4**

  - [ ]* 12.3 Write property test for context assembly order is deterministic
    - **Property 27: Context Assembly Order Is Deterministic**
    - Call `assembleContext()` twice with identical inputs, verify output text is identical.
    - **Validates: Requirements 15.1**

- [x] 13. Implement disk budget enforcement and message limits
  - [x] 13.1 Implement `enforceDiskBudget()` in MemoryManager
    - Calculate total size of all `.jsonl` files under `transcripts/` + size of `memory.db`
    - When over budget, delete oldest transcript files (by mtime), remove corresponding index entries from MemoryIndex and VectorIndex
    - Run on startup and after every 100 `recordMessage()` calls (tracked by counter)
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 13.2 Implement message limit pruning in `recordMessage()`
    - After recording a message, check if chat exceeds `maxMessagesPerChat`
    - If so, call `MemoryIndex.prune()` and optionally `VectorIndex` prune
    - Preserve JSONL transcript files on disk (only prune index)
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ]* 13.3 Write property test for disk budget enforcement
    - **Property 15: Disk Budget Enforcement**
    - Create transcript files and DB exceeding budget, call `enforceDiskBudget()`, verify total size ≤ budget, deleted files are oldest, and corresponding index entries removed.
    - **Validates: Requirements 6.2, 6.3**

  - [ ]* 13.4 Write property test for pruning preserves transcript files
    - **Property 14: Pruning Preserves Transcript Files**
    - After pruning index entries, verify JSONL transcript files on disk remain unchanged (same content, same size).
    - **Validates: Requirements 5.4**

- [x] 14. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Implement mid-session auto-compaction
  - [x] 15.1 Implement `checkAutoCompact()` in MemoryManager
    - Estimate current session transcript token count using `chars / 4` heuristic
    - When exceeding `autoCompactThreshold`, silently trigger daily compaction of oldest messages up to threshold boundary via `CompactionEngine.compact()`
    - Remove compacted messages from working-memory window but retain in JSONL transcript on disk
    - Append to existing daily file if one already exists
    - On LLM failure, log error, continue without compacting, retry on next check
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

  - [ ]* 15.2 Write property test for mid-session auto-compaction triggers at threshold
    - **Property 28: Mid-Session Auto-Compaction Triggers at Threshold**
    - Create session transcript exceeding threshold, call `checkAutoCompact()`, verify daily-tier compaction produced, working-memory window reduced below threshold, JSONL transcript retains all original messages.
    - **Validates: Requirements 16.1, 16.2, 16.3, 16.4**

- [x] 16. Complete MemoryManager coordinator and wire sub-components
  - [x] 16.1 Complete `MemoryManager` with all remaining methods
    - Wire `TranscriptWriter`, `TranscriptParser`, `MemoryIndex`, `VectorIndex` (optional), `CompactionEngine`, `SleepCycleRunner`, `ContextAssembler` as owned sub-components
    - `initialize(): Promise<void>` — create directories, open DB, init schema, optionally load embedding model
    - `recordMessage(record)` — append to transcript, index in FTS, optionally index in vector, check message limits, check disk budget every 100 writes
    - `search(query, opts)` — delegate to hybrid search (FTS + optional vector)
    - `loadRecentMessages(chatId, sessionId, count)` — delegate to `TranscriptParser.parseTail()`
    - `compactSession(params)` — delegate to `CompactionEngine.compact()`
    - `runConsolidation(params)` — delegate to `SleepCycleRunner.runPendingConsolidations()`
    - `assembleContext(params)` — delegate to `ContextAssembler.assemble()`
    - `close()` — close DB connection
    - When `memoryEnabled = false`, all methods are no-ops
    - All public methods wrapped in try/catch, never throw
    - _Requirements: 1.5, 1.6, 7.2, 7.3_

- [x] 17. Integrate MemoryManager with SessionManager
  - [x] 17.1 Add optional `MemoryManager` dependency to `SessionManager`
    - Modify `agentbridge/src/components/session-manager.ts` constructor to accept optional `memory?: MemoryManager`
    - In `getOrCreateSession()`: call `memory.persistSession()` on new session creation, call `memory.touchSession()` on existing session access
    - In `resetSession()`: call `memory.deactivateSession()` before deleting from Map
    - Add `restoreFromMemory()` method: query `memory.restoreSessions()`, load recent messages per session via `memory.loadRecentMessages()`, populate the sessions Map
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 8.1, 8.2, 8.3, 8.4_

- [x] 18. Integrate memory layer into main.ts
  - [x] 18.1 Initialize MemoryManager in `main()`
    - Load `MemoryConfig` via `loadMemoryConfig()`
    - If `memoryEnabled`, create and initialize `MemoryManager`
    - Restore sessions from memory on startup, log count
    - Pass `MemoryManager` to `SessionManager` constructor
    - Run lazy consolidation (`runConsolidation`) on session start
    - _Requirements: 7.2, 7.3, 8.1, 8.4, 12.1_

  - [x] 18.2 Wire message recording into `handleUpdate()`
    - After user sends a message: call `memory.recordMessage()` with role "user"
    - After assistant response: call `memory.recordMessage()` with role "assistant"
    - After each `recordMessage()`: call `memory.checkAutoCompact()` for mid-session auto-compaction
    - _Requirements: 2.1, 2.2, 16.2_

  - [x] 18.3 Implement `/compact`, `/new` (with auto-compact), `/facts`, `/scratchpad` commands
    - `/compact`: call `memory.compactSession()`, send confirmation message
    - `/new`: if `compactOnReset` is true, trigger compaction first, then reset session
    - `/facts`: call `memory.readUserCoreFacts()`, send content to user
    - `/scratchpad`: call `memory.readScratchpad()`, send content to user
    - _Requirements: 10.1, 10.4, 13.2, 14.5_

  - [x] 18.4 Wire context assembly into LLM prompt flow
    - Before sending prompt to LLM, call `memory.assembleContext()` with chatId, userInput, systemPrompt, and working memory
    - Use the assembled context as the full prompt
    - _Requirements: 15.1, 15.5_

  - [x] 18.5 Wire `memory.close()` into shutdown handler
    - Call `memory.close()` in the `shutdown()` function to cleanly close the SQLite database
    - _Requirements: 1.6_

- [x] 19. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All persistence operations use try/catch with graceful degradation — the bridge never crashes due to memory layer failures
- The project uses TypeScript, vitest for testing, fast-check for property-based testing, and better-sqlite3 for SQLite
