# Local Memory — As-Built Documentation

## Overview

The local memory layer is fully implemented and operational across three completed phases plus a search enhancements phase. It provides SQLite-backed persistence, JSONL transcript files, FTS5 full-text search, optional local-model vector search with model-version-aware cosine similarity, hierarchical memory consolidation (daily → weekly → quarterly, with legacy monthly/yearly preserved), dynamic context assembly with token budgets and rolling summary compression, external document ingestion (YouTube, PDF, text/markdown), LLM-generated reflections, embedding model hot-swap with `/reembed`, selective forgetting across all storage layers, heartbeat-driven background memory extraction with English-normalized dual-column storage, agent-initiated memory search with temporal decay and MMR diversity re-ranking, context window monitoring with async compression, and per-session context injection.

### Phase Summary

| Phase | Scope | Status |
|-------|-------|--------|
| Phase 1 — Wire the Foundation | LLM compaction, context assembly in prompt flow, rolling summary | ✅ Complete |
| Phase 2 — Command-Based Features | `/ingest`, `/reflect`, `/reembed`, `/forget` commands | ✅ Complete |
| Memory Search Enhancements | 4+1 tier architecture: heartbeat extraction, English-normalized storage, agent-initiated recall, temporal decay, MMR | ✅ Complete |
| Phase 3 — Intelligence Layer | Proactive recall, importance scoring, contradiction detection, cross-channel linking, feedback loop, topic chunking | 📋 Designed, not implemented |

---

## Architecture (As-Built)

```
src/
├── types/
│   ├── memory.ts              # MessageRecord, MemoryTier, CompactedMemory, StoredSession,
│   │                          # SearchResult, VectorSearchResult, SearchOptions, AssembledContext,
│   │                          # IngestionSource, IngestionResult, IngestedDocument, Reflection,
│   │                          # ForgetResult, RecallAnalysis, PipelineResult,
│   │                          # ExtractedMemory, MemorySearchParams, MemorySearchResult, HeartbeatTask
│   └── index.ts               # Re-exports all types
├── components/
│   ├── memory-config.ts       # MemoryConfig type + loadMemoryConfig() from env vars
│   ├── memory-db.ts           # initializeDatabase() — SQLite schema creation + migrations
│   ├── memory-manager.ts      # MemoryManager — top-level coordinator
│   ├── memory-index.ts        # MemoryIndex — FTS5 full-text search (messages + extracted memories)
│   ├── memory-search-tool.ts  # MemorySearchTool — agent-initiated recall with decay + MMR (NEW)
│   ├── memory-extractor.ts    # MemoryExtractor — LLM-based memory extraction from transcripts (NEW)
│   ├── heartbeat-system.ts    # HeartbeatSystem — periodic background task runner (NEW)
│   ├── context-window-monitor.ts # ContextWindowMonitor — threshold-based async compression (NEW)
│   ├── transcript-writer.ts   # TranscriptWriter — JSONL append
│   ├── transcript-parser.ts   # TranscriptParser — JSONL read
│   ├── compaction-engine.ts   # CompactionEngine — daily compaction + tier consolidation (daily→weekly→quarterly)
│   ├── sleep-cycle-runner.ts  # SleepCycleRunner — lazy hierarchical rollups
│   ├── context-assembler.ts   # ContextAssembler — tiered context with token budgets + English rolling summary + session injection
│   ├── embedding-provider.ts  # EmbeddingProvider — local ONNX embeddings + model hot-swap + reembed
│   ├── vector-index.ts        # VectorIndex — model-version-aware cosine similarity search
│   ├── ingestion-pipeline.ts  # IngestionPipeline — YouTube/PDF/text/markdown document ingestion
│   ├── reflection-engine.ts   # ReflectionEngine — LLM-generated meta-summaries
│   ├── recall-fallback-pipeline.ts # RecallFallbackPipeline — multi-stage search cascade
│   └── intent-detector.ts     # IntentDetector — recall intent and temporal range detection
└── main.ts                    # Transport wiring, command handlers, LLM callback registration
```

---

## Component Inventory

### Foundation (Phase 1 — Wired)

| Component | File | Status | Notes |
|-----------|------|--------|-------|
| Core types | `src/types/memory.ts` | ✅ Complete | All Phase 1+2+Search Enhancement types defined |
| MemoryConfig + loadMemoryConfig() | `src/components/memory-config.ts` | ✅ Complete | 17+ config fields including heartbeat and searchEnhancements sections |
| TranscriptWriter | `src/components/transcript-writer.ts` | ✅ Complete | JSONL append per session |
| TranscriptParser | `src/components/transcript-parser.ts` | ✅ Complete | JSONL read + parseTail() |
| SQLite schema | `src/components/memory-db.ts` | ✅ Complete | 8 tables + 2 FTS5 virtual tables + triggers + migration |
| MemoryIndex (FTS5) | `src/components/memory-index.ts` | ✅ Complete | BM25 search, prune, removeSession, searchExtracted, searchOriginal |
| EmbeddingProvider | `src/components/embedding-provider.ts` | ✅ Complete | ONNX embeddings, model versioning, reembed |
| VectorIndex | `src/components/vector-index.ts` | ✅ Complete | Model-version-aware cosine similarity |
| CompactionEngine | `src/components/compaction-engine.ts` | ✅ Wired to LLM | Daily→weekly→quarterly consolidation, English summaries |
| SleepCycleRunner | `src/components/sleep-cycle-runner.ts` | ✅ Wired to LLM | Lazy hierarchical rollups |
| ContextAssembler | `src/components/context-assembler.ts` | ✅ Wired to prompt flow | 5-tier assembly + English rolling summary + session injection + context window monitoring |
| MemoryManager | `src/components/memory-manager.ts` | ✅ Complete | Coordinator for all subsystems including heartbeat and search tool |
| main.ts integration | `src/main.ts` | ✅ Complete | Both Telegram + Discord wired |

### Command-Based Features (Phase 2)

| Component | File | Status | Notes |
|-----------|------|--------|-------|
| IngestionPipeline | `src/components/ingestion-pipeline.ts` | ✅ Complete | YouTube, PDF, text, markdown |
| ReflectionEngine | `src/components/reflection-engine.ts` | ✅ Complete | LLM-generated topic-clustered digests |
| Embedding Hot-Swap | `src/components/embedding-provider.ts` | ✅ Complete | detectModelChange + reembed |
| Selective Forgetting | `src/components/memory-manager.ts` | ✅ Complete | cascadeDelete, forgetTopic/Range/Session |

### Memory Search Enhancements (4+1 Tier Architecture)

| Component | File | Status | Notes |
|-----------|------|--------|-------|
| HeartbeatSystem | `src/components/heartbeat-system.ts` | ✅ Complete | Periodic background task runner with error isolation |
| MemoryExtractor | `src/components/memory-extractor.ts` | ✅ Complete | LLM-based extraction with dual-column English + original storage |
| MemorySearchTool | `src/components/memory-search-tool.ts` | ✅ Complete | Agent-initiated recall with temporal decay + MMR diversity |
| ContextWindowMonitor | `src/components/context-window-monitor.ts` | ✅ Complete | Threshold-based async compression scheduling |
| RecallFallbackPipeline | `src/components/recall-fallback-pipeline.ts` | ✅ Complete | Multi-stage search cascade (primary→context→relaxed→substring→vector→temporal) |
| IntentDetector | `src/components/intent-detector.ts` | ✅ Complete | Recall intent and temporal range detection |
| MemoryIndex extensions | `src/components/memory-index.ts` | ✅ Complete | searchExtracted() + searchOriginal() for extracted memories FTS5 |
| CompactionEngine updates | `src/components/compaction-engine.ts` | ✅ Complete | Quarterly tier, English summaries, legacy monthly/yearly preserved |
| ContextAssembler updates | `src/components/context-assembler.ts` | ✅ Complete | English rolling summaries, per-session injection, context window monitor integration |
| MemoryConfig extensions | `src/components/memory-config.ts` | ✅ Complete | heartbeat + searchEnhancements config sections |
| Schema extensions | `src/components/memory-db.ts` | ✅ Complete | extracted_memories, extraction_watermarks, dual FTS5 tables |

### Intelligence Layer (Phase 3 — Designed, Not Implemented)

| Component | File | Status | Notes |
|-----------|------|--------|-------|
| Proactive Recall | — | 📋 Planned | Hybrid search on incoming messages |
| ImportanceScorer | — | 📋 Planned | 0.0–1.0 scoring + exponential decay |
| ContradictionDetector | — | 📋 Planned | LLM-based fact contradiction detection |
| Cross-Channel Linking | — | 📋 Planned | Shared index across Telegram + Discord |
| FeedbackTracker | — | 📋 Planned | Tracks recalled memory usefulness |
| Topic-Based Chunking | — | 📋 Planned | Semantic topic boundaries for compaction |

### Tier 4 — Deep Search (Future, Documented Only)

| Component | File | Status | Notes |
|-----------|------|--------|-------|
| Pinecone Vector Search | — | 📋 Planned | Cloud-hosted exhaustive recall, cross-channel, high latency |

---

## Data Flow (As-Built)

### Message Processing Pipeline

1. **Startup**: `main.ts` calls `loadMemoryConfig()` → creates `MemoryManager` → calls `initialize()` which opens/creates SQLite DB, creates schema (including extracted_memories tables), optionally loads embedding model, initializes IngestionPipeline and ReflectionEngine
2. **LLM Callback Registration**: `memory.setLlmCall((prompt, content) => transport.sendPrompt("system:memory", ...))` — enables compaction, context assembly rolling summary, reflections, and memory extraction
3. **Heartbeat Start**: `memory.startHeartbeat()` creates HeartbeatSystem, MemoryExtractor, and MemorySearchTool. Registers two background tasks: memory extraction (processes unprocessed transcripts for active chats) and consolidation (checks compaction thresholds). Heartbeat ticks every 60s (configurable).
4. **Message in**: `main.ts` calls `memory.recordMessage()` → TranscriptWriter appends JSONL → MemoryIndex inserts into SQLite + FTS5 → optionally VectorIndex stores embedding with model version → prunes if over limit → checks disk budget every 100 writes
5. **Background Memory Extraction** (heartbeat-driven): HeartbeatSystem tick → MemoryExtractor queries unprocessed transcripts via watermark → LLM extracts structured memories (facts, decisions, preferences, events) → stores in `extracted_memories` with dual-column `content_en` + `content_original` → FTS5 triggers auto-index `content_en`; `content_original` indexed only when `preserve_original=1` → watermark advanced on success, unchanged on failure
6. **Context Assembly**: `memory.assembleContext({ chatId, channelKey, userInput, systemPrompt, workingMemory, isSessionStart })` builds 5-tier context:
   - Tier 1: Soul (system prompt + user_core_facts.md) — injected at session start only
   - Tier 2: Scratchpad
   - Tier 3: Recalled Memories (top-3 hybrid search results via RecallFallbackPipeline)
   - Tier 4: Working Memory (English rolling summary + last N messages) — rolling summary injected at session start only
   - Tier 5: New Input
   - After assembly, ContextWindowMonitor checks token usage against threshold (default 85%) and schedules async compression via `process.nextTick()` if exceeded
7. **Agent-Initiated Memory Search**: LLM agent calls `memory_search` tool → MemorySearchTool searches extracted_memories FTS5 (English keywords, OR-style) + compactions (weekly/quarterly) + optional original-language fallback → merges + deduplicates → applies temporal decay (`2^(-age/halflife)`) → applies MMR re-ranking (Jaccard similarity) → returns ranked diverse results
8. **Rolling Summary**: When conversation exceeds `rollingBufferSize` (default 20), older messages are compressed into an English rolling summary via LLM. Summary is incrementally updated as new messages displace older ones. Falls back to simple truncation if LLM is unavailable. Labeled `[ROLLING SUMMARY (English)]` in context.
9. **Search**: `memory.search()` → delegates to `hybridSearch()` → FTS5 BM25 results + optional vector cosine similarity (model-version-filtered) → reciprocal rank fusion merge
10. **Auto-Compaction**: After recording a message, if the session transcript exceeds `autoCompactThreshold` tokens, `checkAutoCompact()` silently triggers daily compaction via the LLM. On failure, original messages are preserved.
11. **Background Consolidation** (heartbeat-driven): Checks compaction thresholds per active chat → 7 daily → weekly, 12 weekly → quarterly. All summaries generated in English.
12. **Shutdown**: `memory.stopHeartbeat()` → `memory.close()` closes SQLite connection

### Heartbeat-Driven Memory Extraction Flow

1. HeartbeatSystem tick fires (every `MEMORY_HEARTBEAT_INTERVAL_MS`, default 60s)
2. Memory extraction task queries active sessions from `sessions` table
3. For each active chat, MemoryExtractor calls `processTranscripts(chatId)`:
   - Reads watermark from `extraction_watermarks` table (0 if none)
   - Queries unprocessed messages from `messages` table where `timestamp > watermark`, ordered ASC
   - Builds transcript string from messages
   - Calls LLM with extraction prompt to produce structured `ExtractedMemory[]`
   - LLM extracts facts, decisions, preferences, events; discards noise
   - LLM produces dual-column: `content_en` (English) + `content_original` (original language)
   - LLM detects keyword preservation intent → sets `preserve_original=true` + `preserved_keyword`
   - Inserts memories into `extracted_memories` table (FTS5 triggers handle indexing)
   - Advances watermark on success; leaves unchanged on failure for retry

### Agent-Initiated Memory Search Flow

1. LLM agent decides it needs to recall past information
2. Agent invokes `memory_search` tool with `{ keywords, original_keyword?, time_range? }`
3. MemorySearchTool executes:
   - **English keyword search**: FTS5 OR-style query on `extracted_memories_fts` (content_en) + compactions table (weekly/quarterly summaries)
   - **Original-language fallback** (if `original_keyword` provided): FTS5 search on `extracted_memories_original_fts` (content_original), with 1.5x score boost for `preserve_original=true` matches
   - **Merge + deduplicate**: Combines English and original results, keeps higher score on duplicates
   - **Temporal decay**: Applies `2^(-age_in_days / half_life)` multiplier to base scores
   - **MMR re-ranking**: Selects diverse results using token-level Jaccard similarity (lambda=0.7 default)
4. Returns ranked, diverse `MemorySearchResult[]` to agent

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

### HeartbeatSystem (Search Enhancements)

The `HeartbeatSystem` is a periodic background task runner inspired by OpenClaw's heartbeat architecture. It executes registered tasks at a configurable interval with error isolation between tasks.

- Each task runs in its own try/catch — a failure in memory extraction does not prevent consolidation from running
- `start()` is idempotent (double-start is a no-op); `stop()` clears the interval timer
- Logs interval and registered task names at info level on start
- If `MEMORY_HEARTBEAT_ENABLED=false`, start() logs "disabled" and returns without creating a timer

Two tasks are registered by `MemoryManager.startHeartbeat()`:
1. **memory-extraction**: Queries active sessions, calls `MemoryExtractor.processTranscripts()` for each
2. **consolidation**: Queries active sessions, checks compaction thresholds via `CompactionEngine.checkConsolidationThresholds()`, runs `SleepCycleRunner.runPendingConsolidations()` if thresholds met

### MemoryExtractor (Search Enhancements)

Uses LLM calls to distill meaningful memories from raw conversation transcripts. Produces `ExtractedMemory` records with dual-column content (original + English).

The LLM prompt instructs the model to:
1. Extract facts, decisions, preferences, and notable events
2. Produce each memory in English (`content_en`) and original language (`content_original`)
3. Set `content_original = content_en` when conversation is already in English
4. Detect explicit keyword preservation intent (e.g., "remember if I say 'ribanc' it is Alexa") and set `preserve_original: true` with the `preserved_keyword` field
5. Discard greetings, filler, step-by-step reasoning, and formatting artifacts

Watermark tracking:
- Per-chat watermark stored in `extraction_watermarks` table
- Only advanced after successful extraction + insert
- On LLM failure or JSON parse failure, watermark stays unchanged → retry on next tick
- Processes transcript segments in chronological order (ASC by timestamp)

### MemorySearchTool (Search Enhancements)

Agent-callable tool for memory recall. Exposed to the LLM agent via system prompt at session start with tool definition:

```json
{
  "name": "memory_search",
  "description": "Search your memory for past conversations, facts, decisions, and preferences.",
  "parameters": {
    "keywords": { "type": "array", "items": { "type": "string" }, "description": "English search terms" },
    "original_keyword": { "type": "string", "description": "Optional original-language keyword for fallback search" },
    "time_range": {
      "type": "object",
      "properties": {
        "start": { "type": "number", "description": "Start timestamp (Unix ms)" },
        "end": { "type": "number", "description": "End timestamp (Unix ms)" }
      }
    }
  }
}
```

Search pipeline:
1. **English keyword search**: FTS5 OR-style matching on `extracted_memories_fts` (content_en) via `MemoryIndex.searchExtracted()`
2. **Compaction search**: FTS5 search on `compactions` table for weekly and quarterly summaries via direct SQL
3. **Original-language fallback** (optional): FTS5 search on `extracted_memories_original_fts` via `MemoryIndex.searchOriginal()` with `boostPreserved=true` (1.5x score multiplier for `preserve_original=1`)
4. **Merge + deduplicate**: Combines all result sets, keeps higher score on duplicate content
5. **Temporal decay**: `score *= 2^(-age_in_days / half_life)` where `age_in_days = (now - source_timestamp) / 86400000`
6. **MMR re-ranking**: Token-level Jaccard similarity (`|intersection|/|union|`) on `content` fields. First pick = highest scored; subsequent picks penalize candidates similar to already-selected. Lambda configurable (default 0.7).

Graceful degradation:
- Temporal decay failure → returns base scores
- MMR failure → returns pre-MMR order
- Any search error → returns empty array, logged but not propagated
- Timeout handling via `MEMORY_SEARCH_TIMEOUT_MS` (default 1000ms)

### ContextWindowMonitor (Search Enhancements)

Monitors context window token usage at prompt construction time. Called during `ContextAssembler.assemble()` after all tiers are assembled.

- `shouldCompress(currentTokens, maxTokens)`: returns `true` when `(currentTokens / maxTokens) * 100 > thresholdPct`
- `scheduleCompression(channelKey)`: uses `process.nextTick()` to run compression after current event loop cycle — does NOT block the current LLM request
- On monitor failure, context assembly proceeds normally without scheduling compression

### Context Assembly Changes (Search Enhancements)

1. **English rolling summary**: The `updateRollingSummary` prompt instructs the LLM to produce summaries "IN ENGLISH" regardless of conversation language. Section label is `[ROLLING SUMMARY (English)]`. On LLM failure, retains previous valid summary.

2. **Per-session injection**: `sessionInjectionState` map (channelKey → boolean) tracks whether Tier 1+2 has been injected for the current session:
   - First message of session (`isSessionStart=true`) or unknown state: inject CoreFacts + RollingSummary
   - Subsequent messages in same session: omit CoreFacts + RollingSummary
   - `resetSessionInjection(channelKey)` re-enables injection (called on staleness reset)
   - Default to injecting on unknown state (fail-safe)

3. **Context window monitoring**: After assembling context, checks token usage against threshold and schedules async compression if needed via ContextWindowMonitor.

### CompactionEngine Changes (Search Enhancements)

- **Tier simplification**: Supports daily, weekly, and quarterly tiers only for new compactions
- **Consolidation thresholds**: 7 daily → 1 weekly, 12 weekly → 1 quarterly
- **English summaries**: All compaction prompts instruct the LLM to produce English summaries
- **Legacy preservation**: Existing monthly/yearly files left in place, not deleted or reprocessed
- `MemoryTier` type updated to `"daily" | "weekly" | "quarterly" | "monthly" | "yearly"` (monthly/yearly kept for backward compat with existing data)

### MemoryIndex Extensions (Search Enhancements)

Two new methods added to `MemoryIndex`:

- `searchExtracted(query, opts?)`: FTS5 search on `extracted_memories_fts` (content_en) with chatId, time range, limit filters. Returns `MemorySearchResult[]` with `tier: "extracted"`.
- `searchOriginal(query, opts?)`: FTS5 search on `extracted_memories_original_fts` (content_original) with optional `boostPreserved` flag (1.5x score multiplier for `preserve_original=1` matches). Returns `MemorySearchResult[]`.

Both methods use `sanitizeFtsQuery()` for FTS5 special character handling and return empty arrays on error.

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
- **ContextAssembler** — for English rolling summary generation
- **ReflectionEngine** — via `MemoryManager.reflect()`
- **MemoryExtractor** — for background memory extraction from transcripts (Search Enhancements)

All consumers handle null/missing callback gracefully: compaction and consolidation skip silently with a debug log, context assembly falls back to raw user input, rolling summary falls back to simple truncation, memory extraction is not registered as a heartbeat task if llmCall is null.

### Ingestion Pipeline (Phase 2)

The `IngestionPipeline` accepts four source types:
- **YouTube**: Uses `youtube-transcript` npm package to extract transcript segments
- **PDF**: Uses `pdf-parse` npm package to extract text content
- **Text/Markdown**: Direct `fs.readFileSync()`

Text is chunked using a whitespace-based approximation (1 token ≈ 4 chars, default max 512 tokens per chunk). Chunks are stored as `compaction`-role messages in the messages table with session ID `ingest:{identifier}`, then embedded via VectorIndex. Metadata is recorded in the `ingested_documents` table.

### Reflection Engine (Phase 2)

The `ReflectionEngine` generates human-readable meta-summaries by:
1. Querying compacted summaries and recent messages within the time window (default 7 days)
2. Building a content block with compacted summaries and conversation history
3. Calling the LLM with a prompt to generate a topic-clustered markdown digest
4. Extracting the first non-empty line as a one-line preview
5. Writing the reflection to `reflections/{channelKey}/YYYY-MM-DD.md`

### Embedding Model Hot-Swap (Phase 2)

The `EmbeddingProvider` tracks model versions:
- `modelVersion` getter returns the configured model name (default `Xenova/all-MiniLM-L6-v2`)
- `detectModelChange(db)` checks if any stored embedding has a different `model_version`
- `reembed({ db, onProgress })` re-generates all stale embeddings in-place — no search downtime
- The `VectorIndex.search()` method filters by `model_version = ?` matching the current model

### Selective Forgetting (Phase 2)

Three forget strategies, all backed by `cascadeDelete()`:

- **`forgetTopic(chatId, topic, threshold?)`** — Uses `hybridSearch()` to find semantically related messages above the relevance threshold (default 0.8), then cascade deletes.
- **`forgetRange(chatId, startDate, endDate)`** — Queries messages by timestamp range, then cascade deletes.
- **`forgetSession(chatId, sessionId)`** — Queries messages by session ID, then cascade deletes.

`cascadeDelete()` performs deletion across all 6 storage layers: embeddings, messages (FTS5 auto-cleaned via trigger), compactions (DB + .md files), and transcript JSONL files (rewritten excluding deleted entries).

---

## SQLite Schema (As-Built)

Eight tables plus three FTS5 virtual tables:

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
  tier TEXT NOT NULL DEFAULT 'daily',  -- 'daily', 'weekly', 'quarterly' (legacy: 'monthly', 'yearly')
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

-- Extracted memories (Search Enhancements — Tier 3 Collection)
CREATE TABLE extracted_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  content_original TEXT NOT NULL,
  content_en TEXT NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'fact',  -- 'fact', 'decision', 'preference', 'event'
  source_timestamp INTEGER NOT NULL,
  preserve_original INTEGER NOT NULL DEFAULT 0,
  preserved_keyword TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_extracted_memories_chat_ts ON extracted_memories(chat_id, source_timestamp DESC);
CREATE INDEX idx_extracted_memories_preserve ON extracted_memories(preserve_original) WHERE preserve_original = 1;

-- FTS5 index over extracted memories (English content, porter + unicode61)
CREATE VIRTUAL TABLE extracted_memories_fts USING fts5(
  content_en, content=extracted_memories, content_rowid=id,
  tokenize='porter unicode61'
);
-- Sync triggers: extracted_memories_ai (AFTER INSERT), extracted_memories_ad (AFTER DELETE)

-- FTS5 index for original-language content (unicode61 only, no porter stemming)
-- Separate table because: unicode61 tokenizer (no English stemming), trigger only fires for preserve_original=1
CREATE VIRTUAL TABLE extracted_memories_original_fts USING fts5(
  content_original, content=extracted_memories, content_rowid=id,
  tokenize='unicode61'
);
-- Conditional triggers: extracted_memories_orig_ai (AFTER INSERT WHEN preserve_original=1),
--                       extracted_memories_orig_ad (AFTER DELETE WHEN preserve_original=1)

-- Extraction watermark (tracks last processed timestamp per chat)
CREATE TABLE extraction_watermarks (
  chat_id INTEGER PRIMARY KEY,
  last_processed_timestamp INTEGER NOT NULL
);
```

WAL mode enabled. Foreign keys enabled. Migration handles adding `model_version` column to existing databases via `ALTER TABLE` with safe error catch.

---

## File System Layout (As-Built)

```
~/.agentbridge/memory/
├── memory.db                                    # SQLite (8 tables + 3 FTS5 virtual tables)
├── transcripts/{chatId}/{sessionId}.jsonl       # Raw conversation transcripts
├── memory/daily/{chatId}/YYYY-MM-DD.md          # Daily compaction summaries
├── memory/weekly/{chatId}/YYYY-Wxx.md           # Weekly consolidation summaries
├── memory/quarterly/{chatId}/YYYY-Qx.md         # Quarterly consolidation summaries (NEW)
├── memory/monthly/{chatId}/YYYY-MM.md           # LEGACY (preserved, not created by new code)
├── memory/yearly/{chatId}/YYYY.md               # LEGACY (preserved, not created by new code)
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
| `MEMORY_RECALL_FALLBACK_ENABLED` | `true` | SE | Enable recall fallback pipeline |
| `MEMORY_RECALL_FALLBACK_TIMEOUT_MS` | `500` | SE | Recall fallback pipeline timeout |
| `MEMORY_RECALL_CONTEXT_MESSAGES` | `5` | SE | Context messages for recall fallback |
| `MEMORY_RECALL_MIN_TOKEN_LENGTH` | `3` | SE | Minimum token length for recall |
| `MEMORY_RECALL_CUE_PHRASES` | (built-in) | SE | JSON array of cue phrases for recall intent |
| `MEMORY_HEARTBEAT_ENABLED` | `true` | SE | Enable/disable heartbeat background processing |
| `MEMORY_HEARTBEAT_INTERVAL_MS` | `60000` | SE | Heartbeat tick interval in milliseconds |
| `MEMORY_SEARCH_TIMEOUT_MS` | `1000` | SE | Memory search tool timeout |
| `MEMORY_DECAY_HALFLIFE_DAYS` | `30` | SE | Temporal decay half-life for search scoring |
| `MEMORY_MMR_LAMBDA` | `0.7` | SE | MMR relevance vs. diversity balance (1.0=pure relevance, 0.0=pure diversity) |
| `MEMORY_COMPACT_THRESHOLD_PCT` | `85` | SE | Context window compression threshold percentage |

(SE = Search Enhancements phase)

---

## Type Definitions (As-Built)

All types are defined in `src/types/memory.ts` and re-exported from `src/types/index.ts`:

| Type | Phase | Description |
|------|-------|-------------|
| `MessageRecord` | — | Single conversation turn (role, content, timestamp, chatId, sessionId) |
| `MemoryTier` | — | `"daily" \| "weekly" \| "quarterly" \| "monthly" \| "yearly"` (monthly/yearly for backward compat) |
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
| `RecallAnalysis` | SE | Intent detection result (hasRecallIntent, temporalRange, strippedQuery, hasTopicKeywords) |
| `PipelineResult` | SE | Recall fallback pipeline result (results, stage, isFallback) |
| `ExtractedMemory` | SE | Structured memory from transcripts (chat_id, content_original, content_en, memory_type, source_timestamp, preserve_original, preserved_keyword, created_at) |
| `MemorySearchParams` | SE | Agent search tool parameters (keywords[], original_keyword?, time_range?) |
| `MemorySearchResult` | SE | Search tool result (content, content_original?, memory_type?, source_timestamp, tier, score) |
| `HeartbeatTask` | SE | Background task definition (name, execute function) |

---

## Error Handling (As-Built)

Consistent "try, log, continue" pattern throughout:
- All MemoryManager public methods catch exceptions internally and never throw to callers
- Errors logged via `logError`/`logWarn` with component-specific tags
- Bridge never crashes due to memory layer failures
- If SQLite fails to initialize, MemoryManager enters no-op mode
- If embedding model fails to load, falls back to FTS-only search
- Context assembly falls back to raw user input on any failure
- Rolling summary falls back to simple truncation when LLM is unavailable; retains previous valid summary on LLM error
- Auto-compaction preserves original messages on LLM failure
- Consolidation preserves unconsolidated messages on failure
- Cascade delete logs file I/O errors but continues (partial cleanup is acceptable)
- Ingestion pipeline returns descriptive error messages for extraction failures

### Search Enhancements Error Handling

- **HeartbeatSystem**: Each task runs in its own try/catch — task failure does not stop other tasks or the heartbeat loop. If heartbeat fails to start, MemoryManager continues without background processing.
- **MemoryExtractor**: LLM failure → watermark not advanced, retry on next tick. JSON parse failure → segment skipped, watermark unchanged. DB write failure → transaction rolled back, raw messages unaffected.
- **MemorySearchTool**: FTS5 query failure → empty result set. Vector search failure → FTS-only fallback. Temporal decay failure → base scores returned. MMR failure → pre-MMR order returned. Any error → empty array, logged but not propagated.
- **ContextWindowMonitor**: `shouldCompress()` failure → compression not scheduled, request proceeds normally.
- **ContextAssembler session injection**: Unknown state (e.g., after restart) → defaults to injecting CoreFacts + RollingSummary (fail-safe).
- **Configuration**: All numeric env vars parsed via `parseNumberEnvSafe` (logs warning, returns default). Boolean env vars use `parseBooleanEnv`. Never throws.

---

## Deviations from Original Design

1. **StoredSession.channelKey instead of telegramChatId** — Implementation uses `channelKey: string` to support both Telegram and Discord. SQLite column is still `telegram_chat_id` but the type maps it to a generic string key. Forward-compatible improvement.

2. **ContextAssembler.assemble() is async** — Design showed synchronous signature. Implementation returns `Promise<AssembledContext>` because recalled memories tier calls `hybridSearch()` which involves async vector search. Correct decision.

3. **MemoryIndex.index() returns messageId** — Design showed `void`. Implementation returns the inserted `messages.id` so it can be passed to `VectorIndex.index(messageId, content)`. Necessary for the vector indexing pipeline.

4. **MemoryManager.assembleContext() returns string** — Design showed `AssembledContext`. Implementation returns `Promise<string>` (just the text) since callers in main.ts only need the assembled text, not the usage breakdown. Simplifies the integration.

5. **ContextAssembler is instantiated per-call** — Design implied a long-lived instance. Implementation creates a new `ContextAssembler` in each `assembleContext()` call. Rolling summaries are therefore not persisted across calls (they reset each time). This is a known limitation — rolling summary state should ideally be maintained on MemoryManager.

6. **Compaction regeneration after forgetting not implemented** — Design specified that forgetting consolidated content should regenerate affected summaries. Current implementation removes the compactions but does not regenerate them. Logged as a known limitation.

7. **MemorySearchTool uses MemoryIndex directly, not VectorIndex** — The search enhancements design showed optional vector search integration in the MemorySearchTool. The implementation uses FTS5 search via MemoryIndex for both English and original-language search, and direct SQL for compaction search. Vector search is not integrated into the MemorySearchTool (it remains available via the existing `hybridSearch()` path in MemoryManager).

8. **Temporal decay and MMR are module-level functions** — Design showed them as private methods on MemorySearchTool. Implementation extracts `applyTemporalDecay()`, `applyMMR()`, `tokenize()`, and `jaccardSimilarity()` as module-level functions for testability. The MemorySearchTool class calls them internally.

---

## Known Limitations

1. **Rolling summary state not persisted across assembleContext() calls** — ContextAssembler is created fresh each call, so the rolling summary `Map` resets. Long conversations won't benefit from incremental summary updates across separate message exchanges. Fix: maintain ContextAssembler (or its rolling summary map) as a field on MemoryManager.

2. **Compaction regeneration after forgetting** — When `cascadeDelete` removes compactions that contained forgotten content, the higher-tier summaries are not regenerated. The compaction files are deleted but no replacement summary is produced.

3. **Ingested document chunks cannot be re-embedded** — `reembed()` skips embeddings with `message_id = NULL`. Ingested document chunks are stored with a message_id (as `compaction`-role messages), so they can be re-embedded. However, any orphaned embeddings without a linked message are skipped.

4. **Session restore not called on startup** — `restoreSessions()` exists but main.ts doesn't call it during initialization.

5. **better-sqlite3 Node version mismatch** — The native module must be rebuilt (`npm rebuild better-sqlite3`) when switching Node versions. Known issue with native addons on WSL.

6. **MemorySearchTool does not integrate vector search** — The agent-initiated search tool uses FTS5 only (English + original-language). Vector similarity search is available via the existing `hybridSearch()` path in MemoryManager but is not wired into the MemorySearchTool pipeline. This means the search tool relies on keyword matching rather than semantic similarity for extracted memories.

7. **Optional property-based tests not implemented** — The design document specifies 26 correctness properties with corresponding property-based tests. These were marked as optional in the task list and were not implemented in the MVP. Unit tests cover the core functionality.

8. **Broader content_original search not implemented** — The design mentions that non-preserved memories could be searched via LIKE/substring matching on `content_original`. The current implementation only searches `content_original` via the `extracted_memories_original_fts` index, which only contains `preserve_original=1` rows.

---

## Test Coverage

262 tests passing across 21 test files.

Test files:
- `tests/fts5-query-sanitization.test.ts` — FTS5 query sanitization edge cases
- `src/components/compaction-engine.test.ts` — compaction logic, tier consolidation, quarterly thresholds
- `src/components/config.test.ts` — config parsing
- `src/components/context-assembler.test.ts` — context assembly tiers, token budgets, English rolling summary, session injection
- `src/components/intent-detector.test.ts` — recall intent and temporal range detection
- `src/components/jsonrpc.test.ts` — JSON-RPC protocol handling
- `src/components/memory-config.test.ts` — memory config parsing, heartbeat + searchEnhancements sections, env var handling
- `src/components/memory-e2e.test.ts` — end-to-end flows (lifecycle, disk budget, auto-compaction)
- `src/components/memory-index.test.ts` — FTS5 indexing, search, prune, removeSession
- `src/components/memory-manager.test.ts` — MemoryManager integration (recordMessage, search, scratchpad, facts, heartbeat, search tool)
- `src/components/memory-properties.test.ts` — property-based tests (indexed messages searchable, score ordering, search filters, session deletion, pruning, scratchpad round-trip, context assembly budgets, malformed JSONL handling)
- `src/components/memory-search-tool.test.ts` — MemorySearchTool (English search, original-language fallback, temporal decay, MMR diversity, timeout, error handling, merge dedup, preserve-original boost)
- `src/components/recall-fallback-pipeline.test.ts` — multi-stage search cascade, temporal range threading, timeout enforcement
- `src/components/response-formatter.test.ts` — response formatting
- `src/components/security-gate.test.ts` — security gate checks
- `src/components/session-manager.test.ts` — session manager + MemoryManager integration
- `src/components/sleep-cycle-runner.test.ts` — consolidation scheduling
- `src/components/tmux-client.test.ts` — tmux client lifecycle
- `src/components/transcript-parser.test.ts` — JSONL reading and parseTail
- `src/components/transcript-writer.test.ts` — JSONL writing
- `src/components/vector-index.test.ts` — vector search, cosine similarity, hybrid search FTS-only mode

---

## Phase 3 — Planned (Not Implemented)

The following features are designed in `docs/specs/memory-enhancements/` with full requirements, design, and task breakdowns. They are marked as optional/future in the task list.

| Feature | Description | Key Config |
|---------|-------------|------------|
| Proactive Recall | Hybrid search on incoming messages, auto-surface relevant memories | `MEMORY_PROACTIVE_RECALL_THRESHOLD` (0.7), `MEMORY_PROACTIVE_RECALL_LIMIT` (3) |
| Importance Scoring | 0.0–1.0 content classification + exponential time decay | `MEMORY_DECAY_HALF_LIFE_DAYS` (30) |
| Contradiction Detection | LLM-based detection of facts contradicting core facts | `MEMORY_CONTRADICTION_THRESHOLD` (0.8) |
| Cross-Channel Linking | Shared semantic index across Telegram + Discord | Cross-channel search default on |
| Feedback Loop | Track recalled memory usefulness, tune retrieval ranking | `feedback_signals` SQLite table |
| Topic-Based Chunking | Semantic topic boundaries for compaction instead of time-only | `MEMORY_MIN_TOPIC_CHUNK_SIZE` (5) |

Phase 3 requires Phase 1 to be stable (it is) and benefits from Phase 2's embedding hot-swap and ingestion pipeline (both complete), as well as the Search Enhancements' heartbeat system and extracted memories infrastructure.

## Tier 4 — Deep Search (Future, Documented Only)

| Feature | Description | Key Config |
|---------|-------------|------------|
| Pinecone Vector Search | Cloud-hosted exhaustive recall via Pinecone free tier | Cross-channel, high latency |
| LLM Semantic Reranking | LLM-assisted reranking of top candidate results | Post-retrieval step |

Tier 4 is documented in `docs/specs/memory-search-enhancements/requirements.md` (Requirement 17) for future reference only. Not implemented.
