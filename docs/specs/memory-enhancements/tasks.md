# Implementation Plan: Memory Enhancements

## Overview

Incrementally wire dormant memory infrastructure (Phase 1), add command-based features (Phase 2), and plan future intelligence layer tasks (Phase 3). Each task builds on the previous, ending with integration wiring. All code is TypeScript targeting the existing AgentBridge memory system.

## Tasks

- [x] 1. Phase 1 — Wire LLM Compaction
  - [x] 1.1 Add `setLlmCall()` method to MemoryManager and store the callback
    - Add a private `llmCall` field and a public `setLlmCall()` method to `src/components/memory-manager.ts`
    - The callback signature is `(prompt: string, content: string) => Promise<string>`
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 1.2 Wire `/compact` command to pass real LlmCall to CompactionEngine
    - In the MemoryManager `/compact` handler, pass `this.llmCall` to `CompactionEngine.compact()`
    - Return the generated summary to the user
    - If `llmCall` is null, return an error message indicating LLM is not available
    - _Requirements: 1.1_

  - [x] 1.3 Wire auto-compaction to use real LlmCall
    - In `checkAutoCompact()` (or equivalent threshold check), pass `this.llmCall` to CompactionEngine
    - Log error and preserve original messages if LlmCall fails or times out
    - _Requirements: 1.2, 1.4_

  - [x] 1.4 Wire SleepCycleRunner to use real LlmCall for tier consolidation
    - When MemoryManager triggers `SleepCycleRunner.runPendingConsolidations()`, pass the stored `llmCall`
    - Ensure error handling preserves unconsolidated messages on failure
    - _Requirements: 1.3, 1.4_

  - [ ]* 1.5 Write unit tests for LLM compaction wiring
    - Test that `setLlmCall()` stores the callback and it flows through to CompactionEngine and SleepCycleRunner
    - Test error/timeout fallback preserves original messages
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Phase 1 — Wire Context Assembly into Prompt Flow
  - [x] 2.1 Add `assembleContext()` method to MemoryManager
    - Implement `assembleContext({ chatId, userInput, systemPrompt })` on MemoryManager
    - Call `ContextAssembler.assemble()` with all five tiers (soul/core facts, scratchpad, recalled memories, working memory, new input)
    - Fall back to raw `userInput` if assembly throws, logging a warning
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 2.2 Wire transport message handlers to use assembled context
    - In `src/main.ts`, update both Telegram and Discord message handlers to call `memory.assembleContext()` before sending to LLM
    - Replace raw user message with assembled context text as the prompt payload
    - _Requirements: 2.1, 2.3_

  - [x] 2.3 Call `memory.setLlmCall()` during initialization in main.ts
    - After transport is ready, register the LLM callback: `memory.setLlmCall((prompt, content) => transport.sendPrompt(systemSessionKey, ...))`
    - This enables both compaction (task 1) and context assembly to use the LLM
    - _Requirements: 1.1, 2.1_

  - [ ]* 2.4 Write unit tests for context assembly wiring
    - Test that `assembleContext()` returns assembled text with all five tiers
    - Test fallback to raw user input when assembly fails
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 3. Phase 1 — Rolling Summary for Conversation Buffer
  - [x] 3.1 Add `MEMORY_ROLLING_BUFFER_SIZE` to memory config
    - Add `rollingBufferSize` field to `MemoryConfig` in `src/components/memory-config.ts`
    - Parse from `MEMORY_ROLLING_BUFFER_SIZE` env var, default 20
    - _Requirements: 3.1_

  - [x] 3.2 Implement rolling summary generation in ContextAssembler
    - Add `setLlmCall()` to ContextAssembler for summary generation
    - Add `rollingSummaries: Map<string, string>` to track per-channel summaries
    - Implement `updateRollingSummary()` that compresses displaced messages into existing summary via LlmCall
    - Fall back to simple truncation if LlmCall is unavailable
    - _Requirements: 3.2, 3.4, 3.5_

  - [x] 3.3 Integrate rolling summary into the assemble() flow
    - In `assemble()`, detect when conversation exceeds `rollingBufferSize`
    - Keep last N messages in full detail, compress older messages into rolling summary
    - Prepend rolling summary text before full-detail messages in the working memory tier
    - Incrementally update summary when new messages displace older ones from the buffer window
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 3.4 Write unit tests for rolling summary
    - Test that messages beyond buffer window are compressed
    - Test rolling summary is prepended before recent messages
    - Test incremental update when new messages displace old ones
    - Test fallback to truncation when LlmCall is unavailable
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 4. Checkpoint — Phase 1 complete
  - Ensure all tests pass, ask the user if questions arise.
  - Verify that compaction uses real LLM, context assembly is wired into prompt flow, and rolling summary works.

- [x] 5. Phase 2 — External Document Ingestion Pipeline
  - [x] 5.1 Create IngestionPipeline component and SQLite schema
    - Create `src/components/ingestion-pipeline.ts` with the `IngestionPipeline` class
    - Create `ingested_documents` table in `src/components/memory-db.ts` (id, chat_id, source_type, identifier, chunk_count, ingested_at)
    - Add `ingestChunkMaxTokens` to MemoryConfig, parsed from `MEMORY_INGEST_CHUNK_MAX_TOKENS` (default 512)
    - _Requirements: 4.4, 4.5_

  - [x] 5.2 Implement text extraction methods (YouTube, PDF, text/markdown)
    - Implement `extractYouTube(url)` — extract transcript from YouTube URL
    - Implement `extractPdf(filePath)` — extract text from PDF
    - Implement direct read for text/markdown files
    - Return descriptive error messages on extraction failure
    - _Requirements: 4.1, 4.2, 4.3, 4.7_

  - [x] 5.3 Implement chunking, embedding, and storage
    - Implement `chunkText(text, maxTokens)` to split content into chunks
    - Generate embeddings for each chunk via EmbeddingProvider and store in VectorIndex with source metadata (source type, identifier, timestamp)
    - Record ingestion in `ingested_documents` table
    - Return `IngestionResult` with chunk count and source identifier
    - _Requirements: 4.4, 4.5, 4.6_

  - [x] 5.4 Implement `/ingest` and `/ingest list` command handlers
    - Wire `/ingest <url_or_path>` command in MemoryManager to call `IngestionPipeline.ingest()`
    - Wire `/ingest list` command to call `IngestionPipeline.listIngested()` and display results
    - _Requirements: 4.1, 4.6, 4.8_

  - [ ]* 5.5 Write unit tests for IngestionPipeline
    - Test chunking produces correct chunk sizes
    - Test ingestion stores embeddings with source metadata
    - Test `/ingest list` returns correct document records
    - Test error handling for failed extraction
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

- [x] 6. Phase 2 — Memory Reflections
  - [x] 6.1 Create ReflectionEngine component
    - Create `src/components/reflection-engine.ts` with the `ReflectionEngine` class
    - Constructor takes `db`, `compactionEngine`, and `config`
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 6.2 Implement `reflect()` method
    - Query compacted memories and recent conversations for the given channel over the time window (default 7 days)
    - Use LlmCall to generate natural-language prose organized by topic clusters
    - Store reflection as markdown at `reflections/{channelKey}/YYYY-MM-DD.md`
    - Return `Reflection` with content, preview, and file path
    - Return informative message if insufficient data exists
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6_

  - [x] 6.3 Implement `listReflections()` and wire `/reflect` commands
    - Implement `listReflections(channelKey)` returning dates and one-line previews
    - Wire `/reflect` command in MemoryManager to call `ReflectionEngine.reflect()`
    - Wire `/reflect list` command to call `listReflections()`
    - _Requirements: 5.5_

  - [ ]* 6.4 Write unit tests for ReflectionEngine
    - Test reflection generation produces markdown with topic clusters
    - Test reflection is stored at correct file path
    - Test `listReflections()` returns correct entries
    - Test insufficient data returns informative message
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 7. Phase 2 — Embedding Model Hot-Swap
  - [x] 7.1 Add model version tracking to EmbeddingProvider and embeddings table
    - Add `model_version` column to embeddings table in `memory-db.ts` (default: `'Xenova/all-MiniLM-L6-v2'`)
    - Add `embeddingModel` to MemoryConfig, parsed from `MEMORY_EMBEDDING_MODEL`
    - Store model version with each new embedding
    - Implement `detectModelChange(db)` to compare configured model vs stored model version
    - _Requirements: 6.1, 6.2_

  - [x] 7.2 Implement `reembed()` and model-version-aware search
    - Implement `reembed({ db, onProgress })` that re-generates all embeddings with the current model
    - Update VectorIndex cosine similarity search to only compare embeddings with matching model version
    - Ensure existing embeddings continue to serve queries until re-embedding completes
    - _Requirements: 6.3, 6.4, 6.5, 6.6_

  - [x] 7.3 Wire `/reembed` command handler
    - Wire `/reembed` command in MemoryManager to call `EmbeddingProvider.reembed()`
    - Report progress to user (percentage or count)
    - _Requirements: 6.4, 6.5_

  - [ ]* 7.4 Write unit tests for embedding hot-swap
    - Test model version is stored with embeddings
    - Test `detectModelChange()` correctly identifies model changes
    - Test search only compares same-version embeddings
    - Test re-embedding updates all stored embeddings
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [x] 8. Phase 2 — Selective Forgetting
  - [x] 8.1 Implement `cascadeDelete()` private method on MemoryManager
    - Delete from all storage layers: SQLite messages table, FTS5 index, embeddings table, vector index, transcript JSONL files, compacted memory markdown files
    - Return `ForgetResult` with counts from each layer
    - _Requirements: 7.4, 7.5_

  - [x] 8.2 Implement `forgetTopic()`, `forgetRange()`, and `forgetSession()`
    - `forgetTopic(chatId, topic, threshold)`: use hybrid search to find related messages above `MEMORY_FORGET_THRESHOLD` (default 0.8), then cascade delete
    - `forgetRange(chatId, startDate, endDate)`: find messages in date range, cascade delete
    - `forgetSession(chatId, sessionId)`: find messages by session, cascade delete
    - If forgotten content was consolidated into higher-tier compaction, regenerate affected summaries excluding forgotten content
    - _Requirements: 7.1, 7.2, 7.3, 7.6, 7.7_

  - [x] 8.3 Add `MEMORY_FORGET_THRESHOLD` to config and wire `/forget` commands
    - Add `forgetThreshold` to MemoryConfig, parsed from `MEMORY_FORGET_THRESHOLD` (default 0.8)
    - Wire `/forget topic <topic>`, `/forget range <start> <end>`, `/forget session <id>` commands in MemoryManager
    - Report removal counts to user after each operation
    - _Requirements: 7.1, 7.2, 7.3, 7.5, 7.6_

  - [ ]* 8.4 Write unit tests for selective forgetting
    - Test cascade deletion removes from all storage layers
    - Test topic-based forget respects relevance threshold
    - Test range-based forget removes correct date range
    - Test session-based forget removes all session data
    - Test compaction regeneration after forgetting consolidated content
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

- [x] 9. Phase 2 — Add new types to memory.ts
  - Update `src/types/memory.ts` with all Phase 2 types: `IngestionResult`, `IngestedDocument`, `Reflection`, `ForgetResult`
  - Update `AssembledContext.usage` to include `rollingSummary` field
  - _Requirements: 4.5, 4.6, 5.1, 7.4, 7.5_

- [x] 10. Checkpoint — Phase 2 complete
  - Ensure all tests pass, ask the user if questions arise.
  - Verify `/ingest`, `/reflect`, `/reembed`, and `/forget` commands work end-to-end.

- [ ]* 11. Phase 3 — Proactive Recall (Future)
  - [ ]* 11.1 Implement proactive hybrid search on incoming messages
    - In MemoryManager, perform hybrid search against user message content on each incoming message
    - Filter results above `MEMORY_PROACTIVE_RECALL_THRESHOLD` (default 0.7), limit to `MEMORY_PROACTIVE_RECALL_LIMIT` (default 3)
    - Skip proactive recall on first message of a session
    - Add `proactiveRecallThreshold` and `proactiveRecallLimit` to MemoryConfig
    - _Requirements: 8.1, 8.2, 8.4, 8.5_

  - [ ]* 11.2 Annotate proactive recalls in ContextAssembler
    - Pass proactive recall results to `ContextAssembler.assemble()` via `proactiveRecalls` parameter
    - Annotate proactive results with `[PROACTIVE]` label in the recalled memories tier
    - _Requirements: 8.3_

  - [ ]* 11.3 Write unit tests for proactive recall
    - Test proactive search respects threshold and limit
    - Test first-message-of-session skip behavior
    - Test `[PROACTIVE]` annotation in assembled context
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [ ]* 12. Phase 3 — Importance Scoring and Decay (Future)
  - [ ]* 12.1 Create ImportanceScorer component
    - Create `src/components/importance-scorer.ts` with the `ImportanceScorer` class
    - Implement `score(content, role)` returning 0.0–1.0 based on content characteristics
    - Implement `applyDecay({ baseScore, messageTimestamp, now, isCoreFact })` with exponential decay, core facts exempt
    - Add `decayHalfLifeDays` to MemoryConfig (default 30)
    - _Requirements: 9.1, 9.4, 9.6_

  - [ ]* 12.2 Add importance column to messages table and wire scoring into recordMessage
    - Add `importance REAL DEFAULT NULL` column to messages table
    - In MemoryManager `recordMessage()`, call `ImportanceScorer.score()` and store the result
    - _Requirements: 9.2_

  - [ ]* 12.3 Wire importance into compaction and search ranking
    - In CompactionEngine, prioritize higher-importance messages for summary inclusion
    - Implement `computeRankingScore()` combining relevance, decayed importance, and usefulness
    - Factor decayed importance into search result ranking in MemoryManager
    - _Requirements: 9.3, 9.5_

  - [ ]* 12.4 Write unit tests for ImportanceScorer
    - Test scoring classifies decisions/facts higher than greetings
    - Test decay reduces score over time with correct half-life
    - Test core facts are exempt from decay
    - Test ranking score combines all factors correctly
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

- [ ]* 13. Phase 3 — Contradiction Detection (Future)
  - [ ]* 13.1 Create ContradictionDetector component
    - Create `src/components/contradiction-detector.ts` with the `ContradictionDetector` class
    - Implement `detect({ message, coreFacts, llmCall })` that uses LLM to identify contradictions against core facts
    - Return `Contradiction` with new assertion, existing fact, and confidence score, or null if no contradiction / low confidence
    - Add `contradictionConfidenceThreshold` to MemoryConfig (default 0.8)
    - _Requirements: 10.1, 10.5_

  - [ ]* 13.2 Implement contradiction resolution and wire into message flow
    - Implement `resolve({ contradiction, resolution, coreFactsPath })` to update or preserve core facts
    - Wire contradiction check into MemoryManager `recordMessage()` flow
    - Present both assertions to user and prompt for resolution when contradiction detected
    - Log all resolution decisions
    - _Requirements: 10.2, 10.3, 10.4_

  - [ ]* 13.3 Write unit tests for ContradictionDetector
    - Test detection identifies contradictions above confidence threshold
    - Test low-confidence contradictions are silently skipped
    - Test resolution updates core facts file correctly
    - Test resolution preserving existing fact discards new assertion
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

- [ ]* 14. Phase 3 — Cross-Channel Memory Linking (Future)
  - [ ]* 14.1 Enable cross-channel search in VectorIndex and MemoryIndex
    - Update `MemoryIndex.search()` to support omitting `chatId` filter for cross-channel mode
    - Update `hybridSearch()` on MemoryManager to accept `crossChannel` option (default true)
    - VectorIndex already searches across all channels by default — verify this behavior
    - _Requirements: 11.1, 11.2, 11.3, 11.5_

  - [ ]* 14.2 Annotate recalled memories with source channel in ContextAssembler
    - In `buildRecalledSection()`, annotate each snippet with source channel identifier (e.g., `[user @telegram:123]`)
    - Support channel filter parameter to restrict results to a specific channel
    - _Requirements: 11.4, 11.3_

  - [ ]* 14.3 Write unit tests for cross-channel linking
    - Test cross-channel search returns results from all channels
    - Test channel filter restricts results correctly
    - Test channel annotation appears in assembled context
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

- [ ]* 15. Phase 3 — Context Assembly Feedback Loop (Future)
  - [ ]* 15.1 Create FeedbackTracker component and SQLite table
    - Create `src/components/feedback-tracker.ts` with the `FeedbackTracker` class
    - Create `feedback_signals` table (id, memory_id, signal_type, timestamp)
    - Implement `recordSignal(memoryId, signal)` and `getUsefulnessScore(memoryId)`
    - _Requirements: 12.1, 12.2, 12.3, 12.5_

  - [ ]* 15.2 Implement response analysis and wire into ranking
    - Implement `analyzeResponse({ response, recalledMemoryIds, recalledContents })` to detect which memories were referenced
    - Wire feedback tracking into the post-response flow in MemoryManager
    - Factor usefulness score into search result ranking alongside relevance and importance
    - _Requirements: 12.1, 12.2, 12.4_

  - [ ]* 15.3 Write unit tests for FeedbackTracker
    - Test positive signal recorded when memory is referenced in response
    - Test neutral signal recorded when memory is ignored
    - Test usefulness score accumulates correctly over multiple signals
    - Test ranking incorporates usefulness score
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

- [ ]* 16. Phase 3 — Topic-Based Chunking for Compaction (Future)
  - [ ]* 16.1 Implement topic boundary detection in CompactionEngine
    - Implement `identifyTopicChunks({ messages, embeddingProvider, db, minChunkSize })` using semantic similarity between consecutive message groups
    - Fall back to time-based chunking when embeddings unavailable or chunks smaller than `MEMORY_MIN_TOPIC_CHUNK_SIZE` (default 5)
    - Add `minTopicChunkSize` to MemoryConfig
    - _Requirements: 13.1, 13.2, 13.4_

  - [ ]* 16.2 Implement per-topic compaction summaries
    - Implement `compactByTopic({ chatId, chunks, llmCall })` generating one summary per TopicChunk
    - Tag each `CompactedMemory` with a topic label derived from chunk content
    - Add `topic_label` column to compactions table
    - _Requirements: 13.3, 13.5_

  - [ ]* 16.3 Write unit tests for topic-based chunking
    - Test topic boundary detection groups semantically related messages
    - Test fallback to time-based chunking when embeddings unavailable
    - Test fallback when chunks are below minimum size
    - Test topic label is stored with compacted memory
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

- [ ]* 17. Phase 3 — Add Phase 3 types and schema (Future)
  - Update `src/types/memory.ts` with Phase 3 types: `TopicChunk`, `Contradiction`, `FeedbackSignal`, extended `SearchResult` (channelKey, isProactive, importanceScore, usefulnessScore), extended `MessageRecord` (importance)
  - Add Phase 3 config fields to MemoryConfig
  - Run all Phase 3 schema migrations (importance column, feedback_signals table, topic_label column)
  - _Requirements: 8.3, 9.2, 10.1, 12.5, 13.5_

- [ ]* 18. Final Checkpoint — Phase 3 complete (Future)
  - Ensure all tests pass, ask the user if questions arise.
  - Verify proactive recall, importance scoring, contradiction detection, cross-channel linking, feedback loop, and topic chunking all work together.

## Notes

- Phase 1 (tasks 1–4) and Phase 2 (tasks 5–10) are required and should be executed now.
- Phase 3 (tasks 11–18) are marked with `*` as optional/future — they should not be executed until Phase 1 and Phase 2 are stable.
- Tasks marked with `*` at the sub-task level are test tasks that can be skipped for faster MVP.
- Each task references specific requirements for traceability (e.g., `1.1` = Requirement 1, Acceptance Criterion 1).
- Checkpoints at tasks 4, 10, and 18 ensure incremental validation between phases.
