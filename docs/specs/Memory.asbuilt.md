# Local Memory — As-Built Documentation

## Overview

The local memory layer is fully implemented and operational across two completed phases. It provides SQLite-backed persistence, JSONL transcript files, FTS5 full-text search, optional local-model vector search with model-version-aware cosine similarity, hierarchical memory consolidation (daily → weekly → monthly → yearly) wired to a real LLM, dynamic context assembly with token budgets and rolling summary compression, external document ingestion (YouTube, PDF, text/markdown), LLM-generated reflections, embedding model hot-swap with `/reembed`, and selective forgetting across all storage layers.

A third phase (intelligence layer) is designed and task-planned but not yet implemented.

### Phase Summary

| Phase | Scope | Status |
|-------|-------|--------|
| Phase 1 — Wire the Foundation | LLM compaction, context assembly in prompt flow, rolling summary | ✅ Complete |
| Phase 2 — Command-Based Features | `/ingest`, `/reflect`, `/reembed`, `/forget` commands | ✅ Complete |
| Phase 3 — Intelligence Layer | Proactive recall, importance scoring, contradiction detection, cross-channel linking, feedback loop, topic chunking | 📋 Designed, not implemented |

---

## Architecture (As-Built)

```
src/
├── types/
│   ├── memory.ts              # MessageRecord, MemoryTier, CompactedMemory, StoredSession,
│   │                          # SearchResult, VectorSearchResult, SearchOptions, AssembledContext,
│   │                          # IngestionSource, IngestionResult, IngestedDocument, Reflection,
│   │                          # ForgetResult
│   └── index.ts               # Re-exports all types
├── components/
│   ├── memory-config.ts       # MemoryConfig type + loadMemoryConfig() from env vars
│   ├── memory-db.ts           # initializeDatabase() — SQLite schema creation + migrations
│   ├── memory-manager.ts      # MemoryManager — top-level coordinator
│   ├── memory-index.ts        # MemoryIndex — FTS5 full-text search
│   ├── transcript-writer.ts   # TranscriptWriter — JSONL append
│   ├── transcript-parser.ts   # TranscriptParser — JSONL read
│   ├── compaction-engine.ts   # CompactionEngine — daily compaction + tier consolidation
│   ├── sleep-cycle-runner.ts  # SleepCycleRunner — lazy hierarchical rollups
│   ├── context-assembler.ts   # ContextAssembler — tiered context with token budgets + rolling summary
│   ├── embedding-provider.ts  # EmbeddingProvider — local ONNX embeddings + model hot-swap + reembed
│   ├── vector-index.ts        # VectorIndex — model-version-aware cosine similarity search
│   ├── ingestion-pipeline.ts  # IngestionPipeline — YouTube/PDF/text/markdown document ingestion
│   └── reflection-engine.ts   # ReflectionEngine — LLM-generated meta-summaries
└── main.ts                    # Transport wiring, command handlers, LLM callback registration
```

---

## Component Inventory

### Foundation (Phase 1 — Wired)

| Component | File | Status | Notes |
|-----------|------|--------|-------|
| Core types | `src/types/memory.ts` | ✅ Complete | All Phase 1+2 types defined |
| MemoryConfig + loadMemoryConfig() | `src/components/memory-config.ts` | ✅ Complete | 17 config fields, all from env vars |
| TranscriptWriter | `src/components/transcript-writer.ts` | ✅ Complete | JSONL append per session |
| TranscriptParser | `src/components/transcript-parser.ts` | ✅ Complete | JSONL read + parseTail() |
| SQLite schema | `src/components/memory-db.ts` | ✅ Complete | 6 tables + FTS5 + triggers + migration |
| MemoryIndex (FTS5) | `src/components/memory-index.ts` | ✅ Complete | BM25 search, prune, removeSession |
| EmbeddingProvider | `src/components/embedding-provider.ts` | ✅ Complete | ONNX embeddings, model versioning, reembed |
| VectorIndex | `src/components/vector-index.ts` | ✅ Complete | Model-version-aware cosine similarity |
| CompactionEngine | `src/components/compaction-engine.ts` | ✅ Wired to LLM | Daily compaction + tier consolidation |
| SleepCycleRunner | `src/components/sleep-cycle-runner.ts` | ✅ Wired to LLM | Lazy hierarchical rollups |
| ContextAssembler | `src/components/context-assembler.ts` | ✅ Wired to prompt flow | 5-tier assembly + rolling summary |
| MemoryManager | `src/components/memory-manager.ts` | ✅ Complete | Coordinator for all subsystems |
| main.ts integration | `src/main.ts` | ✅ Complete | Both Telegram + Discord wired |

### Command-Based Features (Phase 2)

| Component | File | Status | Notes |
|-----------|------|--------|-------|
| IngestionPipeline | `src/components/ingestion-pipeline.ts` | ✅ Complete | YouTube, PDF, text, markdown |
| ReflectionEngine | `src/components/reflection-engine.ts` | ✅ Complete | LLM-generated topic-clustered digests |
| Embedding Hot-Swap | `src/components/embedding-provider.ts` | ✅ Complete | detectModelChange + reembed |
| Selective Forgetting | `src/components/memory-manager.ts` | ✅ Complete | cascadeDelete, forgetTopic/Range/Session |

### Intelligence Layer (Phase 3 — Designed, Not Implemented)

| Component | File | Status | Notes |
|-----------|------|--------|-------|
| Proactive Recall | — | 📋 Planned | Hybrid search on incoming messages |
| ImportanceScorer | — | 📋 Planned | 0.0–1.0 scoring + exponential decay |
| ContradictionDetector | — | 📋 Planned | LLM-based fact contradiction detection |
| Cross-Channel Linking | — | 📋 Planned | Shared index across Telegram + Discord |
| FeedbackTracker | — | 📋 Planned | Tracks recalled memory usefulness |
| Topic-Based Chunking | — | 📋 Planned | Semantic topic boundaries for compaction |

---

## Data Flow (As-Built)

### Message Processing Pipeline

1. **Startup**: `main.ts` calls `loadMemoryConfig()` → creates `MemoryManager` → calls `initialize()` which opens/creates SQLite DB, creates schema, optionally loads embedding model, initializes IngestionPipeline and ReflectionEngine
2. **LLM Callback Registration**: `memory.setLlmCall((prompt, content) => transport.sendPrompt("system:memory", ...))` — enables compaction, context assembly rolling summary, and reflections to use the LLM
3. **Message in**: `main.ts` calls `memory.recordMessage()` → TranscriptWriter appends JSONL → MemoryIndex inserts into SQLite + FTS5 → optionally VectorIndex stores embedding with model version → prunes if over limit → checks disk budget every 100 writes
4. **Context Assembly**: `memory.assembleContext({ chatId, userInput, systemPrompt })` is called before every `transport.sendPrompt()` on both Telegram and Discord. Builds 5-tier context:
   - Tier 1: Soul (system prompt + user_core_facts.md)
   - Tier 2: Scratchpad
   - Tier 3: Recalled Memories (top-3 hybrid search results)
   - Tier 4: Working Memory (rolling summary + last N messages)
   - Tier 5: New Input
5. **Rolling Summary**: When conversation exceeds `rollingBufferSize` (default 20), older messages are compressed into a rolling summary via LLM. Summary is incrementally updated as new messages displace older ones. Falls back to simple truncation if LLM is unavailable.
6. **Search**: `memory.search()` → delegates to `hybridSearch()` → FTS5 BM25 results + optional vector cosine similarity (model-version-filtered) → reciprocal rank fusion merge
7. **Auto-Compaction**: After recording a message, if the session transcript exceeds `autoCompactThreshold` tokens, `checkAutoCompact()` silently triggers daily compaction via the LLM. On failure, original messages are preserved.
8. **Shutdown**: `memory.close()` closes SQLite connection

### Command Handlers (Telegram + Discord)

| Command | Handler | Description |
|---------|---------|-------------|
| `/new`, `/reset` | Transport reset | Resets session, clears conversation buffer |
| `/status` | Transport status | Shows connection status |
| `/stop`, `/cancel` | Transport interrupt | Sends Ctrl+C to Kiro |
| `/compact` | `memory.compactSession()` | Triggers LLM compaction, returns summary |
| `/facts` | `memory.readUserCoreFacts()` | Displays stored user facts |
| `/scratchpad` | `memory.readScratchpad()` | Displays scratchpad content |
| `/ingest <url_or_path>` | `memory.ingestDocument()` | Ingests YouTube/PDF/text/markdown, reports chunk count |
| `/ingest list` | `memory.listIngestedDocuments()` | Lists all ingested documents with metadata |
| `/reflect` | `memory.reflect()` | Generates LLM reflection over last 7 days (or custom window) |
| `/reflect list` | `memory.listReflections()` | Lists past reflections with dates and previews |
| `/reflect <days>` | `memory.reflect(channelKey, days)` | Generates reflection over custom time window |
| `/reembed` | `memory.reembed()` | Re-generates all embeddings with current model, reports progress at 25% intervals |
| `/forget topic <topic>` | `memory.forgetTopic()` | Semantic search + cascade delete above threshold |
| `/forget range <start> <end>` | `memory.forgetRange()` | Date-range cascade delete (YYYY-MM-DD format) |
| `/forget session <id>` | `memory.forgetSession()` | Session-based cascade delete |

---

## Key Implementation Details

### LLM Callback Wiring (Phase 1)

The `llmCall` callback pattern is used throughout the memory system. A single callback is registered in `main.ts` after transport initialization:

```typescript
memory.setLlmCall(async (prompt: string, content: string) => {
  return transport.sendPrompt("system:memory", `${prompt}\n\n${content}`);
});
```

This callback flows to:
- **CompactionEngine** — via `MemoryManager.compactSession()` and `checkAutoCompact()`
- **SleepCycleRunner** — via `MemoryManager.runConsolidation()`
- **ContextAssembler** — for rolling summary generation (not yet wired through MemoryManager; ContextAssembler creates its own instance per call)
- **ReflectionEngine** — via `MemoryManager.reflect()`

All consumers handle null/missing callback gracefully: compaction and consolidation skip silently with a debug log, context assembly falls back to raw user input, rolling summary falls back to simple truncation.

### Context Assembly (Phase 1)

The `ContextAssembler` builds a 5-tier context window with configurable token budgets per tier. Token estimation uses the `chars / 4` heuristic throughout.

Assembly order (priority):
1. `[SYSTEM]` + `[USER FACTS]` — soul tier (default 500 tokens)
2. `[SCRATCHPAD]` — scratchpad tier (default 300 tokens)
3. `[RECALLED MEMORIES]` — top-3 hybrid search results (default 600 tokens)
4. `[ROLLING SUMMARY]` + `[CONVERSATION]` — working memory tier (default 2000 tokens)
5. `[INPUT]` — new user input (uncapped)

The rolling summary is stored per-channel in a `Map<string, string>` on the ContextAssembler instance. When conversation length exceeds `rollingBufferSize`, displaced messages are compressed into the existing summary via LLM. The summary is prepended before recent messages in the working memory tier and counts against the working memory token budget.

`assembleContext()` on MemoryManager returns `Promise<string>` (the assembled text). On failure, it falls back to the raw `userInput` string with a warning log.

### Ingestion Pipeline (Phase 2)

The `IngestionPipeline` accepts four source types:
- **YouTube**: Uses `youtube-transcript` npm package to extract transcript segments
- **PDF**: Uses `pdf-parse` npm package to extract text content
- **Text/Markdown**: Direct `fs.readFileSync()`

Text is chunked using a whitespace-based approximation (1 token ≈ 4 chars, default max 512 tokens per chunk). Chunks are stored as `compaction`-role messages in the messages table with session ID `ingest:{identifier}`, then embedded via VectorIndex. Metadata is recorded in the `ingested_documents` table.

Source type is auto-detected in `main.ts` command handlers based on URL patterns (youtube.com/youtu.be) and file extensions (.pdf, .md).

### Reflection Engine (Phase 2)

The `ReflectionEngine` generates human-readable meta-summaries by:
1. Querying compacted summaries and recent messages within the time window (default 7 days)
2. Building a content block with compacted summaries and conversation history
3. Calling the LLM with a prompt to generate a topic-clustered markdown digest
4. Extracting the first non-empty line as a one-line preview
5. Writing the reflection to `reflections/{channelKey}/YYYY-MM-DD.md`

`listReflections()` reads the reflection directory, parses first lines as previews, and returns sorted by date descending.

### Embedding Model Hot-Swap (Phase 2)

The `EmbeddingProvider` tracks model versions:
- `modelVersion` getter returns the configured model name (default `Xenova/all-MiniLM-L6-v2`)
- `detectModelChange(db)` checks if any stored embedding has a different `model_version`
- `reembed({ db, onProgress })` re-generates all stale embeddings:
  - Queries embeddings joined with messages to recover original text
  - Skips embeddings without a linked message (ingested chunks with `message_id = NULL`)
  - Updates each row in-place — no search downtime during re-embedding
  - Calls `onProgress(processed, total)` after each row

The `VectorIndex.search()` method filters by `model_version = ?` matching the current model, ensuring only same-model embeddings are compared during cosine similarity.

### Selective Forgetting (Phase 2)

Three forget strategies, all backed by `cascadeDelete()`:

**`forgetTopic(chatId, topic, threshold?)`** — Uses `hybridSearch()` to find semantically related messages above the relevance threshold (default 0.8 from `MEMORY_FORGET_THRESHOLD`), resolves message IDs, then cascade deletes.

**`forgetRange(chatId, startDate, endDate)`** — Queries messages by timestamp range (Date objects converted to Unix ms), then cascade deletes.

**`forgetSession(chatId, sessionId)`** — Queries messages by session ID, then cascade deletes.

**`cascadeDelete(messageIds, chatId)`** performs deletion across all 6 storage layers:
1. Queries messages for session IDs and timestamps before deletion (needed for transcript matching)
2. Deletes from `embeddings` table by `message_id`
3. Deletes from `messages` table (FTS5 `messages_fts` cleaned automatically via the existing `AFTER DELETE` trigger)
4. Deletes related `compactions` from DB + removes `.md` files on disk
5. Rewrites transcript JSONL files excluding deleted entries (matched by timestamp+content signature)
6. Returns `ForgetResult` with counts from each layer

Note: Full compaction regeneration after forgetting consolidated content is not yet implemented. When compactions are removed during a forget operation, a log message notes this limitation.

---

## SQLite Schema (As-Built)

Six tables plus FTS5 virtual table:

```sql
-- Session state
CREATE TABLE sessions (
  telegram_chat_id INTEGER NOT NULL,
  acp_session_id TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  PRIMARY KEY (telegram_chat_id, acp_session_id)
);

-- Conversation messages (source for FTS)
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,          -- 'user', 'assistant', 'compaction'
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL   -- Unix ms
);

-- FTS5 virtual table (porter + unicode61 tokenizer)
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content, content=messages, content_rowid=id,
  tokenize='porter unicode61'
);
-- Sync triggers: messages_ai (AFTER INSERT), messages_ad (AFTER DELETE)

-- Embedding cache (keyed by SHA-256 content hash)
CREATE TABLE embeddings (
  content_hash TEXT PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  vector BLOB NOT NULL,
  model_version TEXT DEFAULT 'Xenova/all-MiniLM-L6-v2'
);

-- Compaction summaries (all tiers)
CREATE TABLE compactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  source_session_id TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'daily',  -- 'daily', 'weekly', 'monthly', 'yearly'
  timestamp INTEGER NOT NULL,
  summary TEXT NOT NULL,
  file_path TEXT NOT NULL
);

-- Ingested documents metadata (Phase 2)
CREATE TABLE ingested_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  source_type TEXT NOT NULL,     -- 'youtube', 'pdf', 'text', 'markdown'
  identifier TEXT NOT NULL,       -- URL or filename
  chunk_count INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL    -- Unix ms
);
```

WAL mode enabled. Foreign keys enabled. Migration handles adding `model_version` column to existing databases via `ALTER TABLE` with safe error catch.

---

## File System Layout (As-Built)

```
~/.agentbridge/memory/
├── memory.db                                    # SQLite (6 tables + FTS5)
├── transcripts/{chatId}/{sessionId}.jsonl       # Raw conversation transcripts
├── memory/daily/{chatId}/YYYY-MM-DD.md          # Daily compaction summaries
├── memory/weekly/{chatId}/YYYY-Wxx.md           # Weekly consolidation summaries
├── memory/monthly/{chatId}/YYYY-MM.md           # Monthly consolidation summaries
├── memory/yearly/{chatId}/YYYY.md               # Yearly consolidation summaries
├── scratchpads/{chatId}/scratchpad.md           # Per-chat scratchpad
├── core/{chatId}/user_core_facts.md             # Per-chat user facts
└── reflections/{channelKey}/YYYY-MM-DD.md       # LLM-generated reflections (Phase 2)
```

---

## Configuration (As-Built)

All configuration is via `MEMORY_*` environment variables parsed in `loadMemoryConfig()`. Invalid values produce a warning and fall back to defaults (never throws).

| Env Var | Default | Phase | Description |
|---------|---------|-------|-------------|
| `MEMORY_ENABLED` | `true` | — | Enable/disable entire memory layer |
| `MEMORY_DIR` | `~/.agentbridge/memory` | — | Base directory for all memory files |
| `MEMORY_MAX_MESSAGES_PER_CHAT` | `1000` | — | Max indexed messages per chat |
| `MEMORY_DISK_BUDGET_MB` | `500` | — | Max total disk usage |
| `MEMORY_VECTOR_ENABLED` | `false` | — | Enable local vector search |
| `MEMORY_STALENESS_HOURS` | `24` | — | Session restore staleness threshold |
| `MEMORY_RESTORE_MESSAGES` | `50` | — | Messages to load on session restore |
| `MEMORY_COMPACT_ON_RESET` | `false` | — | Auto-compact before /new |
| `MEMORY_AUTO_COMPACT_THRESHOLD` | `3000` | — | Token threshold for mid-session auto-compact |
| `MEMORY_CONTEXT_BUDGET_SOUL` | `500` | — | Token budget: system prompt + user facts |
| `MEMORY_CONTEXT_BUDGET_SCRATCHPAD` | `300` | — | Token budget: scratchpad |
| `MEMORY_CONTEXT_BUDGET_RECALLED` | `600` | — | Token budget: recalled memories |
| `MEMORY_CONTEXT_BUDGET_WORKING` | `2000` | — | Token budget: working memory |
| `MEMORY_ROLLING_BUFFER_SIZE` | `20` | 1 | Recent messages kept in full detail |
| `MEMORY_INGEST_CHUNK_MAX_TOKENS` | `512` | 2 | Max token size per ingestion chunk |
| `MEMORY_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | 2 | Embedding model name for hot-swap |
| `MEMORY_FORGET_THRESHOLD` | `0.8` | 2 | Relevance threshold for topic-based forgetting |

---

## Type Definitions (As-Built)

All types are defined in `src/types/memory.ts` and re-exported from `src/types/index.ts`:

| Type | Phase | Description |
|------|-------|-------------|
| `MessageRecord` | — | Single conversation turn (role, content, timestamp, chatId, sessionId) |
| `MemoryTier` | — | `"daily" \| "weekly" \| "monthly" \| "yearly"` |
| `CompactedMemory` | — | LLM-generated summary at any tier |
| `StoredSession` | — | Persisted session state (channelKey, acpSessionId, timestamps) |
| `SearchResult` | — | FTS5/hybrid search result (record + score) |
| `VectorSearchResult` | — | Vector search result (messageId + cosine score) |
| `SearchOptions` | — | Search filter options (chatId, time range, limit) |
| `AssembledContext` | 1 | Assembled context text + per-tier token usage (includes rollingSummary) |
| `IngestionSource` | 2 | Source descriptor (type + identifier) |
| `IngestionResult` | 2 | Ingestion result (sourceType, identifier, chunkCount, timestamp) |
| `IngestedDocument` | 2 | Stored document record (id, sourceType, identifier, chunkCount, ingestedAt, chatId) |
| `Reflection` | 2 | Reflection meta-summary (channelKey, date, content, preview, filePath) |
| `ForgetResult` | 2 | Forget operation result (messagesRemoved, embeddingsRemoved, compactionsRemoved, transcriptEntriesRemoved) |

---

## Error Handling (As-Built)

Consistent "try, log, continue" pattern throughout:
- All MemoryManager public methods catch exceptions internally and never throw to callers
- Errors logged via `logError`/`logWarn` with component-specific tags
- Bridge never crashes due to memory layer failures
- If SQLite fails to initialize, MemoryManager enters no-op mode
- If embedding model fails to load, falls back to FTS-only search
- Context assembly falls back to raw user input on any failure
- Rolling summary falls back to simple truncation when LLM is unavailable
- Auto-compaction preserves original messages on LLM failure
- Consolidation preserves unconsolidated messages on failure
- Cascade delete logs file I/O errors but continues (partial cleanup is acceptable)
- Ingestion pipeline returns descriptive error messages for extraction failures

---

## Deviations from Original Design

1. **StoredSession.channelKey instead of telegramChatId** — Implementation uses `channelKey: string` to support both Telegram and Discord. SQLite column is still `telegram_chat_id` but the type maps it to a generic string key. Forward-compatible improvement.

2. **ContextAssembler.assemble() is async** — Design showed synchronous signature. Implementation returns `Promise<AssembledContext>` because recalled memories tier calls `hybridSearch()` which involves async vector search. Correct decision.

3. **MemoryIndex.index() returns messageId** — Design showed `void`. Implementation returns the inserted `messages.id` so it can be passed to `VectorIndex.index(messageId, content)`. Necessary for the vector indexing pipeline.

4. **MemoryManager.assembleContext() returns string** — Design showed `AssembledContext`. Implementation returns `Promise<string>` (just the text) since callers in main.ts only need the assembled text, not the usage breakdown. Simplifies the integration.

5. **ContextAssembler is instantiated per-call** — Design implied a long-lived instance. Implementation creates a new `ContextAssembler` in each `assembleContext()` call. Rolling summaries are therefore not persisted across calls (they reset each time). This is a known limitation — rolling summary state should ideally be maintained on MemoryManager.

6. **Compaction regeneration after forgetting not implemented** — Design specified that forgetting consolidated content should regenerate affected summaries. Current implementation removes the compactions but does not regenerate them. Logged as a known limitation.

---

## Known Limitations

1. **Rolling summary state not persisted across assembleContext() calls** — ContextAssembler is created fresh each call, so the rolling summary `Map` resets. Long conversations won't benefit from incremental summary updates across separate message exchanges. Fix: maintain ContextAssembler (or its rolling summary map) as a field on MemoryManager.

2. **Compaction regeneration after forgetting** — When `cascadeDelete` removes compactions that contained forgotten content, the higher-tier summaries are not regenerated. The compaction files are deleted but no replacement summary is produced.

3. **Ingested document chunks cannot be re-embedded** — `reembed()` skips embeddings with `message_id = NULL`. Ingested document chunks are stored with a message_id (as `compaction`-role messages), so they can be re-embedded. However, any orphaned embeddings without a linked message are skipped.

4. **Session restore not called on startup** — `restoreSessions()` exists but main.ts doesn't call it during initialization.

5. **better-sqlite3 Node version mismatch** — The native module must be rebuilt (`npm rebuild better-sqlite3`) when switching Node versions. Known issue with native addons on WSL.

---

## Test Coverage

187 tests passing across 16 test files. 3 pre-existing failures in `session-manager.test.ts` (unrelated to memory enhancements).

Test files:
- `memory-config.test.ts` — config parsing and env var handling
- `memory-index.test.ts` — FTS5 indexing, search, prune, removeSession
- `memory-manager.test.ts` — MemoryManager integration (recordMessage, search, scratchpad, facts)
- `memory-e2e.test.ts` — end-to-end flows
- `memory-properties.test.ts` — property-based tests (partial)
- `compaction-engine.test.ts` — compaction logic and tier consolidation
- `sleep-cycle-runner.test.ts` — consolidation scheduling
- `context-assembler.test.ts` — context assembly tiers and token budgets
- `transcript-writer.test.ts` — JSONL writing
- `transcript-parser.test.ts` — JSONL reading and parseTail
- `vector-index.test.ts` — vector search and cosine similarity

Optional property-based tests (Properties 1–28) and Phase 2 unit tests were not implemented per the MVP scope.

---

## Phase 3 — Planned (Not Implemented)

The following features are designed in `.kiro/specs/memory-enhancements/` with full requirements, design, and task breakdowns. They are marked as optional/future in the task list.

| Feature | Description | Key Config |
|---------|-------------|------------|
| Proactive Recall | Hybrid search on incoming messages, auto-surface relevant memories | `MEMORY_PROACTIVE_RECALL_THRESHOLD` (0.7), `MEMORY_PROACTIVE_RECALL_LIMIT` (3) |
| Importance Scoring | 0.0–1.0 content classification + exponential time decay | `MEMORY_DECAY_HALF_LIFE_DAYS` (30) |
| Contradiction Detection | LLM-based detection of facts contradicting core facts | `MEMORY_CONTRADICTION_THRESHOLD` (0.8) |
| Cross-Channel Linking | Shared semantic index across Telegram + Discord | Cross-channel search default on |
| Feedback Loop | Track recalled memory usefulness, tune retrieval ranking | `feedback_signals` SQLite table |
| Topic-Based Chunking | Semantic topic boundaries for compaction instead of time-only | `MEMORY_MIN_TOPIC_CHUNK_SIZE` (5) |

Phase 3 requires Phase 1 to be stable (it is) and benefits from Phase 2's embedding hot-swap and ingestion pipeline (both complete).
