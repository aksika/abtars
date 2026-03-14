# Implementation Plan: Instant Memory Store

## Overview

Add immediate memory persistence via an agent-initiated `instant_store` tool. The LLM agent decides when to store memories (instead of regex detection), invokes `agentbridge-store` CLI, and provides emotion scores. Includes `emotion_score` field on all extracted memories and `log1p`-based emotion boosting in search ranking.

## Tasks

- [x] 1. Add `emotion_score` to data model and schema
  - [x] 1.1 Add `emotion_score` field to `ExtractedMemory` type
    - In `src/types/memory.ts`, add `emotion_score: number` to the `ExtractedMemory` type
    - _Requirements: 7.4_

  - [x] 1.2 Add schema migration for `emotion_score` column
    - In `MemoryManager.initialize()`, run `ALTER TABLE extracted_memories ADD COLUMN emotion_score INTEGER DEFAULT 0`
    - Wrap in try/catch to handle the case where the column already exists (idempotent migration)
    - _Requirements: 7.1_

  - [x] 1.3 Create `src/components/emotion-utils.ts` with `clampEmotionScore` utility
    - Export `clampEmotionScore(value: unknown): number` — clamps to [-5, +5], defaults to 0 for non-integers/null/undefined/NaN
    - _Requirements: 7.3, 7.7_

  - [x] 1.4 Write property test for emotion score clamping (Property 1)
    - **Property 1: Emotion Score Clamping**
    - *For any* value (integers in [-100, +100], floats, null, undefined, NaN), `clampEmotionScore()` returns a value in [-5, +5]. Integer values in range preserved exactly; outside range clamped to boundary; non-integers default to 0.
    - Use `fast-check` generators: `fc.integer()`, `fc.oneof(fc.constant(undefined), fc.constant(null), fc.constant(NaN), fc.double())`
    - Test file: `src/components/emotion-utils.test.ts`
    - **Validates: Requirements 7.3, 7.7**

- [x] 2. Implement `instantStore()` on `MemoryManager`
  - [x] 2.1 Add `InstantStoreParams` and `InstantStoreResult` types to `src/types/memory.ts`
    - `InstantStoreParams`: `chatId`, `contentEn`, `contentOriginal`, `memoryType`, `emotionScore`, `keyword?`
    - `InstantStoreResult`: `stored`, `memoriesCount`, `error?`
    - _Requirements: 2.1_

  - [x] 2.2 Implement `instantStore()` method on `MemoryManager`
    - Validate inputs: non-empty `contentEn` and `contentOriginal`, valid `memoryType`
    - Clamp `emotionScore` via `clampEmotionScore()`
    - INSERT into `extracted_memories` with `preserve_original = true`, `source_timestamp = Date.now()`
    - Advance watermark to `Date.now()`
    - Return `{ stored: true, memoriesCount: 1 }` on success
    - On error: log, return `{ stored: false, error: message }`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1_

  - [x] 2.3 Write property test for valid memory persistence (Property 2)
    - **Property 2: Instant Store Persists Valid Memories**
    - *For any* valid `InstantStoreParams`, `instantStore()` inserts exactly one row with `preserve_original = true` and all fields matching input
    - Use in-memory SQLite with full schema
    - Test file: `src/components/instant-store.test.ts`
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**

  - [x] 2.4 Write property test for invalid input rejection (Property 3)
    - **Property 3: Instant Store Rejects Invalid Inputs**
    - *For any* params with empty `contentEn` or empty `contentOriginal`, returns `{ stored: false }` and no DB row inserted
    - Test file: `src/components/instant-store.test.ts`
    - **Validates: Requirements 2.2, 3.1**

  - [x] 2.5 Write property test for watermark advance (Property 4)
    - **Property 4: Watermark Advance Prevents Heartbeat Re-Extraction**
    - *For any* chat where `instantStore()` succeeds, a subsequent `processTranscripts()` does not re-extract messages up to that timestamp
    - Use in-memory SQLite with full schema
    - Test file: `src/components/instant-store.test.ts`
    - **Validates: Requirements 4.1, 4.2**

- [x] 3. Checkpoint
  - Ensure all instantStore tests pass. Ask the user if questions arise.

- [x] 4. Create `agentbridge-store` CLI
  - [x] 4.1 Create `src/cli/agentbridge-store.ts`
    - Parse CLI arguments: `--content-en`, `--content-original`, `--memory-type`, `--emotion-score`, `--chat-id`, `--keyword`
    - Validate required params, output error JSON for missing/invalid params
    - Load memory config, initialize MemoryManager
    - Call `memory.instantStore()` with parsed params
    - Output JSON result to stdout
    - Follow same patterns as `src/cli/agentbridge-recall.ts`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 4.2 Add `agentbridge-store` to `package.json` bin field
    - Add entry pointing to compiled CLI: `"agentbridge-store": "./dist/cli/agentbridge-store.js"`
    - _Requirements: 2.1_

  - [x] 4.3 Write property test for CLI argument validation (Property 8)
    - **Property 8: CLI Argument Validation**
    - *For any* invocation missing a required parameter, the command outputs `{ "stored": false, "error": "..." }` and does not modify the database
    - Test file: `src/cli/agentbridge-store.test.ts`
    - **Validates: Requirements 2.2**

- [x] 5. Create instant-store skill definition
  - [x] 5.1 Create `skills/instant-store/SKILL.md`
    - Follow same format as `skills/memory-search/SKILL.md`
    - Document: tool purpose, CLI invocation syntax, all parameters with examples
    - "When to use" section: explicit storage requests (EN/HU), frustration signals, emotionally significant statements, important facts/decisions/preferences
    - "When NOT to use" section: routine messages, greetings, confirmations, info already in context
    - Include emotion score scale with examples for each level (-5 to +5)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 6. Checkpoint
  - Ensure CLI works end-to-end: build, run `agentbridge-store` with test params, verify DB insertion. Ask the user if questions arise.

- [x] 7. Update `MemoryExtractor` for emotion score
  - [x] 7.1 Update extraction prompt to include `emotion_score` field
    - In `src/components/memory-extractor.ts`, add `emotion_score` to the extraction prompt output format
    - Add the [-5, +5] scale description with examples
    - _Requirements: 7.2, 7.5_

  - [x] 7.2 Update `parseResponse()` to parse and clamp `emotion_score`
    - Import `clampEmotionScore` from `emotion-utils.ts`
    - Parse `emotion_score` from each LLM response object, apply clamping
    - Add `emotion_score` to returned `ExtractedMemory` objects
    - _Requirements: 7.3, 7.7_

  - [x] 7.3 Update `insertMemories()` to persist `emotion_score`
    - Add `emotion_score` to the INSERT statement columns and VALUES
    - _Requirements: 7.6_

- [x] 8. Update search ranking with emotion boost
  - [x] 8.1 Add `EMOTION_BOOST_WEIGHT` constant to `memory-index.ts`
    - Export `const EMOTION_BOOST_WEIGHT = 0.5`
    - _Requirements: 8.4_

  - [x] 8.2 Update `searchExtracted()` to apply emotion boost
    - Add `em.emotion_score` to the SELECT clause
    - Apply `EMOTION_BOOST_WEIGHT * Math.log(1 + Math.abs(row.emotion_score))` additive boost
    - _Requirements: 8.1, 8.2, 8.3, 8.5_

  - [x] 8.3 Update `searchOriginal()` to apply emotion boost
    - Same additive boost formula as `searchExtracted()`
    - _Requirements: 8.1, 8.2, 8.3, 8.5_

  - [x] 8.4 Write property test for emotion boost formula (Property 5)
    - **Property 5: Emotion Boost Formula Correctness**
    - *For any* BM25 score and `emotion_score` in [-5, +5], final score equals `bm25_score + 0.5 * Math.log(1 + Math.abs(emotion_score))`. When `emotion_score` is 0, boost is exactly 0.
    - Test file: `src/components/emotion-boost.test.ts`
    - **Validates: Requirements 8.1, 8.2, 8.3**

  - [x] 8.5 Write property test for emotional > neutral ranking (Property 6)
    - **Property 6: Emotional Memories Rank Higher Than Neutral Ones**
    - *For any* two memories with identical BM25 scores, one neutral (`emotion_score = 0`) and one emotional (`|emotion_score| > 0`), the emotional memory has strictly higher final score
    - Test file: `src/components/emotion-boost.test.ts`
    - **Validates: Requirements 8.1**

  - [x] 8.6 Write property test for emotion score round-trip (Property 7)
    - **Property 7: Emotion Score Storage Round-Trip**
    - *For any* memory stored via `instantStore()` with `emotion_score` in [-5, +5], retrieving via search preserves the `emotion_score` value exactly
    - Use in-memory SQLite with full schema
    - Test file: `src/components/emotion-boost.test.ts`
    - **Validates: Requirements 7.6**

- [x] 9. Final checkpoint
  - Run full test suite. Verify all 8 property tests pass with ≥100 iterations each. Ask the user if questions arise.

## Notes

- All property tests use `fast-check` with vitest, consistent with existing test patterns
- The `clampEmotionScore` utility is in `src/components/emotion-utils.ts`, shared by CLI and MemoryExtractor
- Schema migration is idempotent — safe to run on existing databases
- `agentbridge-store` CLI follows the same pattern as `agentbridge-recall` CLI
- SKILL.md follows the same format as `skills/memory-search/SKILL.md`
- No changes to `main.ts` message pipeline — the agent handles everything via tool calls
- Each task references specific requirements for traceability
