# Implementation Plan: Memory Search Enhancements (4+1 Tier Architecture)

## Overview

Incremental implementation of the 4+1 tier memory architecture for AgentBridge. Each task builds on the previous, starting with configuration and data models, then new components (heartbeat, extractor, search tool), then modifications to existing components (ContextAssembler, CompactionEngine, MemoryIndex, MemoryManager), and finally wiring everything together. Property-based tests use `fast-check` via vitest.

## Tasks

- [x] 1. Extend configuration and type definitions
  - [x] 1.1 Add new types to `src/types/memory.ts`
    - Add `ExtractedMemory`, `MemorySearchParams`, `MemorySearchResult`, `HeartbeatTask` types
    - Update `MemoryTier` to `"daily" | "weekly" | "quarterly"` (keep `"monthly" | "yearly"` for backward compat)
    - _Requirements: 5.3, 6.5, 8.1, 9.3_

  - [x] 1.2 Extend `src/components/memory-config.ts` with new config sections
    - Add `heartbeat` section: `enabled` (MEMORY_HEARTBEAT_ENABLED, default true), `intervalMs` (MEMORY_HEARTBEAT_INTERVAL_MS, default 60000)
    - Add `searchEnhancements` section: `searchTimeoutMs` (default 1000), `decayHalflifeDays` (default 30), `mmrLambda` (default 0.7), `compactThresholdPct` (default 85)
    - Parse all new env vars using existing `parseNumberEnvSafe` and `parseBooleanEnv` helpers
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_

  - [ ]* 1.3 Write property test for configuration resilience (Property 24)
    - **Property 24: Configuration Resilience**
    - Generate random env var strings (valid numbers, invalid strings, empty, missing); verify `loadMemoryConfig()` returns config with no `undefined`, `NaN`, `Infinity`, or `null` in any field
    - **Validates: Requirements 2.5, 4.7, 13.5, 15.2, 15.3**

  - [ ]* 1.4 Write unit tests for MemoryConfig
    - Test all new env vars parsed with correct defaults
    - Test valid overrides, invalid values use defaults and log warnings
    - Test heartbeat and searchEnhancements sections present
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_

- [x] 2. Extend database schema
  - [x] 2.1 Add extracted memories tables and indexes to `src/components/memory-db.ts`
    - Create `extracted_memories` table with columns: id, chat_id, content_original, content_en, memory_type, source_timestamp, preserve_original, preserved_keyword, created_at
    - Create indexes: `idx_extracted_memories_chat_ts`, `idx_extracted_memories_preserve`
    - Create `extracted_memories_fts` FTS5 virtual table (porter unicode61 tokenizer on content_en)
    - Create `extracted_memories_original_fts` FTS5 virtual table (unicode61 tokenizer on content_original, triggered only for preserve_original=1)
    - Create all FTS5 sync triggers (insert/delete for both FTS tables)
    - Create `extraction_watermarks` table (chat_id PRIMARY KEY, last_processed_timestamp)
    - _Requirements: 6.1, 6.2, 6.5, 7.2_

- [x] 3. Checkpoint — Verify schema and config
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement HeartbeatSystem
  - [x] 4.1 Create `src/components/heartbeat-system.ts`
    - Implement `HeartbeatSystem` class with `registerTask()`, `start()`, `stop()`, and private `tick()` methods
    - Each task runs in its own try/catch for error isolation
    - Log interval and registered task names at info level on start
    - Support graceful start/stop with timer cleanup; idempotent start/stop
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [ ]* 4.2 Write property test for heartbeat task error isolation (Property 6)
    - **Property 6: Heartbeat Task Error Isolation**
    - Generate random arrays of tasks where some throw errors; verify all tasks (throwing and non-throwing) are attempted and non-throwing tasks complete
    - **Validates: Requirements 4.1, 4.4**

  - [ ]* 4.3 Write unit tests for HeartbeatSystem
    - Test start/stop lifecycle, tick executes all tasks, task failure isolation, invalid interval uses default, double-start/stop idempotent, logging
    - _Requirements: 4.1, 4.4, 4.5, 4.6, 4.7_

- [x] 5. Implement MemoryExtractor
  - [x] 5.1 Create `src/components/memory-extractor.ts`
    - Implement `MemoryExtractor` class with `processTranscripts()`, private `extractFromSegment()`, `getWatermark()`, private `updateWatermark()`
    - LLM prompt instructs extraction of facts/decisions/preferences/events in English + original language
    - Detect `preserve_original` intent from explicit user phrasing patterns
    - Set `content_original = content_en` when conversation is already in English
    - Track watermark per chat; do not advance on failure
    - Process transcript segments in chronological order
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.4, 7.1, 7.3, 7.4_

  - [ ]* 5.2 Write property test for ExtractedMemory structural invariant (Property 7)
    - **Property 7: ExtractedMemory Structural Invariant**
    - Generate random ExtractedMemory records; verify non-empty content_original, non-empty content_en, valid memory_type, positive source_timestamp, boolean preserve_original
    - **Validates: Requirements 5.3, 6.1**

  - [ ]* 5.3 Write property test for watermark monotonicity (Property 8)
    - **Property 8: Watermark Monotonicity and Failure Safety**
    - Generate random sequences of timestamps with success/failure; verify watermark monotonically increases on success and stays unchanged on failure
    - **Validates: Requirements 5.4, 5.5**

  - [ ]* 5.4 Write property test for chronological processing order (Property 9)
    - **Property 9: Chronological Processing Order**
    - Generate random unordered transcript segments; verify processing order is ascending by source_timestamp
    - **Validates: Requirements 5.6**

  - [ ]* 5.5 Write property test for preserved keyword field invariant (Property 12)
    - **Property 12: Preserved Keyword Field Invariant**
    - Generate memories with random preserve_original flag; verify preserved_keyword is non-null/non-empty when preserve_original=true, and null/undefined when false
    - **Validates: Requirements 7.4**

  - [ ]* 5.6 Write unit tests for MemoryExtractor
    - Test English transcript extraction, Hungarian dual-column extraction, preserve_original detection, noise skipping, watermark advance/non-advance, chronological order, empty transcript
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 7.1, 7.3, 7.4_

- [x] 6. Extend MemoryIndex for extracted memories
  - [x] 6.1 Add `searchExtracted()`, `searchOriginal()`, and `indexExtractedMemory()` methods to `src/components/memory-index.ts`
    - `searchExtracted()`: FTS5 search on `extracted_memories_fts` (content_en) with chatId, time range, limit filters
    - `searchOriginal()`: FTS5 search on `extracted_memories_original_fts` (content_original) with optional preserve_original boost
    - `indexExtractedMemory()`: Insert into FTS5; index content_en always, index content_original only when preserve_original=true
    - _Requirements: 6.2, 7.2, 10.1, 11.1, 11.3_

  - [ ]* 6.2 Write property test for FTS5 round-trip (Property 10)
    - **Property 10: FTS5 Round-Trip for Extracted Memories**
    - Generate random content_en strings, insert into DB, search by non-trivial token from content_en; verify the memory is found
    - **Validates: Requirements 6.2, 10.1**

  - [ ]* 6.3 Write property test for dual FTS5 indexing (Property 11)
    - **Property 11: Dual FTS5 Indexing for Preserved Originals**
    - Generate memories with random preserve_original flag; verify content_en search always finds them, content_original search finds only preserve_original=true memories
    - **Validates: Requirements 7.2**

  - [ ]* 6.4 Write unit tests for MemoryIndex extensions
    - Test insert + search by content_en token, preserve_original=true search by content_original, preserve_original=false not found in original FTS, FTS5 special character sanitization
    - _Requirements: 6.2, 7.2, 10.1, 11.1_

- [x] 7. Checkpoint — Verify collection pipeline components
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement TemporalDecayScorer and MMRReranker utilities
  - [x] 8.1 Implement temporal decay scoring function
    - Create utility function (in `src/components/memory-search-tool.ts` or a shared utils file) that applies `2^(-age_in_days / half_life)` multiplier to base scores
    - `age_in_days = (now - source_timestamp) / 86400000`
    - Graceful degradation: return base scores on computation error
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 16.5_

  - [ ]* 8.2 Write property test for temporal decay formula (Property 22)
    - **Property 22: Temporal Decay Formula**
    - Generate random ages (0–365 days) and half-lives (1–365 days); verify multiplier equals `2^(-age/halflife)`, 0-day-old memory has multiplier 1.0, half-life-day-old memory has multiplier 0.5, newer memory scores >= older memory with same base score
    - **Validates: Requirements 13.1, 13.2, 13.3, 13.4**

  - [x] 8.3 Implement MMR re-ranking function
    - Implement MMR using token-level Jaccard similarity on `content_en` fields
    - First result = highest scored; subsequent selections penalize candidates similar to already-selected
    - Configurable lambda (default 0.7); skip when fewer than 2 results
    - Graceful degradation: return pre-MMR order on computation error
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 16.5_

  - [ ]* 8.4 Write property test for MMR diversity re-ranking (Property 23)
    - **Property 23: MMR Diversity Re-Ranking**
    - Generate result sets of 2+ entries with varying content; verify first result is highest-scored, equal-relevance candidates prefer lower Jaccard similarity to selected, Jaccard computed as |intersection|/|union|
    - **Validates: Requirements 14.1, 14.2, 14.4**

  - [ ]* 8.5 Write property test for graceful degradation of decay and MMR (Property 25)
    - **Property 25: Graceful Degradation for Decay and MMR**
    - Generate results + error-throwing decay/MMR implementations; verify base scores returned without failure
    - **Validates: Requirements 16.5**

- [x] 9. Implement MemorySearchTool
  - [x] 9.1 Create `src/components/memory-search-tool.ts`
    - Implement `MemorySearchTool` class with `search()`, private `searchEnglish()`, `searchOriginalLanguage()`, `mergeResults()`, `applyTemporalDecay()`, `applyMMR()`
    - English keyword search: FTS5 OR-style matching on content_en across extracted memories + compacted summaries
    - Original-language fallback: search content_original, boost preserve_original=true matches
    - Merge + deduplicate results (prefer higher scores)
    - Apply temporal decay, then MMR re-ranking
    - Timeout handling: return whatever results are available at timeout
    - Error handling: return empty array on any error, log but don't propagate
    - _Requirements: 9.1, 9.4, 9.5, 9.6, 10.1, 10.3, 10.4, 11.1, 11.2, 11.3, 11.4, 12.1, 12.2, 12.3, 12.4, 13.1, 14.1_

  - [ ]* 9.2 Write property test for search results ordered by score (Property 15)
    - **Property 15: Search Results Ordered by Score**
    - Generate random result arrays from search; verify descending score order
    - **Validates: Requirements 9.4**

  - [ ]* 9.3 Write property test for search error returns empty (Property 16)
    - **Property 16: Search Error Returns Empty Results**
    - Generate random error conditions (db error, timeout, parse error); verify empty array returned, no throw
    - **Validates: Requirements 9.6, 16.3**

  - [ ]* 9.4 Write property test for OR-style multi-keyword matching (Property 17)
    - **Property 17: OR-Style Multi-Keyword FTS5 Matching**
    - Generate 2+ keywords and memories each matching exactly one keyword; verify all matching memories returned (union)
    - **Validates: Requirements 10.4**

  - [ ]* 9.5 Write property test for original-language search (Property 18)
    - **Property 18: Original-Language Search Finds Matches**
    - Generate original_keyword and memories with matching content_original; verify those memories are in results
    - **Validates: Requirements 11.1**

  - [ ]* 9.6 Write property test for merge deduplication (Property 19)
    - **Property 19: Merge Deduplication Prefers Higher Scores**
    - Generate two result arrays with overlapping memory IDs but different scores; verify no duplicates and max score kept
    - **Validates: Requirements 11.2**

  - [ ]* 9.7 Write property test for preserve-original score boost (Property 20)
    - **Property 20: Preserve-Original Score Boost**
    - Generate pairs of results (preserved vs not) with same base score; verify preserved has strictly higher score
    - **Validates: Requirements 11.4**

  - [ ]* 9.8 Write property test for cross-tier search coverage (Property 21)
    - **Property 21: Cross-Tier Search Coverage**
    - Insert data across extracted, weekly, quarterly tiers; verify all tiers searched and tier labels accurate
    - **Validates: Requirements 12.1, 12.2, 12.3**

  - [ ]* 9.9 Write unit tests for MemorySearchTool
    - Test English keyword search, original-language fallback, temporal decay ranking, MMR diversity, timeout partial results, error empty array, OR-style matching, merge dedup, preserve-original boost, cross-tier results, empty keywords, single result MMR skip
    - _Requirements: 9.1, 9.4, 9.5, 9.6, 10.1, 10.4, 11.1, 11.2, 11.4, 12.1, 13.1, 14.1, 14.5_

- [x] 10. Checkpoint — Verify search pipeline
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement ContextWindowMonitor and modify ContextAssembler
  - [x] 11.1 Create `src/components/context-window-monitor.ts`
    - Implement `ContextWindowMonitor` class with `shouldCompress()` and `scheduleCompression()`
    - `shouldCompress()`: returns true when `(currentTokens / maxTokens) * 100 > thresholdPct`
    - `scheduleCompression()`: uses `setImmediate()`/`process.nextTick()` to run compression after current event loop cycle
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ]* 11.2 Write property test for context window threshold comparison (Property 4)
    - **Property 4: Context Window Threshold Comparison**
    - Generate random currentTokens, maxTokens, thresholdPct; verify shouldCompress returns true when usage > threshold, false otherwise
    - **Validates: Requirements 2.3**

  - [x] 11.3 Modify `src/components/context-assembler.ts` for English rolling summaries
    - Update `updateRollingSummary` prompt to instruct LLM to produce summary in English
    - Change section label to `[ROLLING SUMMARY (English)]`
    - On LLM failure: retain previous valid summary, log warning
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 16.4_

  - [ ]* 11.4 Write property test for English rolling summary prompt instruction (Property 1)
    - **Property 1: English Rolling Summary Prompt Instruction**
    - Generate random message arrays; verify the prompt string sent to llmCall contains "English"
    - **Validates: Requirements 1.1**

  - [ ]* 11.5 Write property test for rolling summary section label (Property 2)
    - **Property 2: Rolling Summary Section Label**
    - Generate random non-empty summary strings; verify assembled output contains `[ROLLING SUMMARY (English)]`
    - **Validates: Requirements 1.2**

  - [ ]* 11.6 Write property test for summary failure retains previous (Property 3)
    - **Property 3: Summary Failure Retains Previous**
    - Generate random previous summaries + error-throwing llmCall; verify previous summary returned unchanged
    - **Validates: Requirements 1.4, 16.4**

  - [x] 11.7 Modify `src/components/context-assembler.ts` for per-session context injection
    - Add `sessionInjectionState` map (channelKey → boolean)
    - On first message of session (isSessionStart=true or unknown state): inject CoreFacts + RollingSummary
    - On subsequent messages in same session: omit CoreFacts + RollingSummary
    - Add `resetSessionInjection(channelKey)` method for staleness reset
    - Default to injecting on unknown state (fail-safe)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ]* 11.8 Write property test for per-session context injection (Property 5)
    - **Property 5: Per-Session Context Injection**
    - Generate random channel keys + message sequences; verify injection on first call, omission on subsequent, re-injection after reset, independent state per channel key
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**

  - [x] 11.9 Integrate ContextWindowMonitor into ContextAssembler
    - After assembling context, call `shouldCompress()` and schedule async compression if needed
    - On monitor failure: proceed normally without scheduling compression
    - _Requirements: 2.1, 2.3, 2.4_

  - [ ]* 11.10 Write unit tests for ContextWindowMonitor and ContextAssembler changes
    - Test threshold comparison (above/at/below), default threshold 85, invalid config uses default
    - Test English summary prompt, section label, session injection/omission/reset, LLM failure fallback, unknown channel key default
    - _Requirements: 1.1, 1.2, 1.4, 2.1, 2.3, 2.5, 3.1, 3.2, 3.3, 3.5_

- [x] 12. Modify CompactionEngine for tier simplification
  - [x] 12.1 Update `src/components/compaction-engine.ts`
    - Update `MemoryTier` to support daily, weekly, quarterly only for new compactions
    - Set consolidation thresholds: weekly=7 daily summaries, quarterly=12 weekly summaries
    - Update compaction prompts to produce English summaries
    - Leave existing monthly/yearly files in place (no deletion or reprocessing)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [ ]* 12.2 Write property test for compaction consolidation thresholds (Property 13)
    - **Property 13: Compaction Consolidation Thresholds**
    - Generate random counts of daily/weekly summaries; verify consolidation triggers at 7 daily → weekly and 12 weekly → quarterly, and not below thresholds
    - **Validates: Requirements 8.2, 8.3**

  - [ ]* 12.3 Write property test for no monthly/yearly compactions (Property 14)
    - **Property 14: No Monthly or Yearly Compactions Created**
    - Generate consolidation runs; verify output tiers are only daily, weekly, or quarterly
    - **Validates: Requirements 8.4, 8.5**

  - [ ]* 12.4 Write unit tests for CompactionEngine changes
    - Test 7 daily → weekly trigger, 6 daily no trigger, 12 weekly → quarterly trigger, 11 weekly no trigger, English content, no monthly/yearly created, legacy files preserved
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

- [x] 13. Checkpoint — Verify context assembly and compaction changes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Wire everything together in MemoryManager
  - [x] 14.1 Extend `src/components/memory-manager.ts` with heartbeat lifecycle and search tool
    - Add `heartbeat`, `memoryExtractor`, `memorySearchTool` fields
    - Implement `startHeartbeat()`: create HeartbeatSystem, register memory extraction task and consolidation task, start
    - Implement `stopHeartbeat()`: stop heartbeat, called from `close()`
    - Implement `getMemorySearchTool()` and `memorySearch()` (delegates to MemorySearchTool, returns empty on error)
    - Register heartbeat tasks: memory extraction (processTranscripts for active chats) and consolidation (check compaction thresholds)
    - Graceful degradation: if heartbeat fails to start, log warning and continue without background processing
    - _Requirements: 4.1, 4.2, 4.3, 9.1, 16.1, 16.2, 16.3_

  - [ ]* 14.2 Write property test for extraction failure preserves raw data (Property 26)
    - **Property 26: Extraction Failure Preserves Raw Data**
    - Generate messages, insert into messages table, fail extraction; verify messages table and messages_fts remain intact and searchable
    - **Validates: Requirements 16.2**

  - [x] 14.3 Add memory_search tool definition to system prompt
    - Add tool definition JSON for `memory_search` with `keywords`, `original_keyword`, `time_range` parameters
    - Include tool description and usage guidance in system prompt at session start
    - _Requirements: 9.1, 9.2, 9.3_

  - [ ]* 14.4 Write unit tests for MemoryManager integration
    - Test heartbeat start/stop lifecycle, memory search delegation, graceful degradation on heartbeat failure, graceful degradation on search error
    - _Requirements: 4.1, 4.5, 9.1, 16.1, 16.3_

- [x] 15. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate the 26 correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Tier 4 (Deep Search) and RRF are documented as future only — no implementation tasks included
- All new env vars follow the existing `MEMORY_*` naming pattern and use `parseNumberEnvSafe`/`parseBooleanEnv` helpers
