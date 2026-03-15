# Local Memory — As-Built Documentation

## Overview

The local memory layer provides SQLite-backed persistence, JSONL transcript files, FTS5 full-text search, optional local-model vector search, external document ingestion, LLM-generated reflections, embedding model hot-swap, selective forgetting, heartbeat-driven background extraction with English-normalized dual-column storage, agent-initiated memory search with temporal decay and MMR diversity, agent-initiated instant memory storage with emotion scoring, emotion-boosted search ranking, an automated sleep maintenance cycle with template-based subagent instructions, immutable chat_backup safety table, emoji stripping before DB indexing, and regex-based prompt injection scanning on A2A inbound messages.

**Recall architecture**: The bridge does NOT inject recalled memories or context into the prompt. The LLM agent handles all recall autonomously — it reads the `memory-search.md` steering file, decides when to search, extracts relevant keywords from user input, and invokes `agentbridge-recall` via `execute_bash`. This leverages the LLM's natural language understanding for keyword extraction instead of a heuristic pipeline.

### Phase Summary

| Phase | Scope | Status |
|-------|-------|--------|
| Phase 1 — Foundation | LLM compaction, context assembly, rolling summary | ✅ Complete |
| Phase 2 — Commands | `/ingest`, `/reflect`, `/reembed`, `/forget` | ✅ Complete |
| Search Enhancements | Heartbeat extraction, English-normalized storage, agent recall, temporal decay, MMR | ✅ Complete |
| Instant Memory Store | Agent-initiated storage, emotion scoring, emotion-boosted ranking | ✅ Complete |
| Sleep CLI | Automated overnight maintenance: state gathering, subagent-driven cleanup, audit trail | ✅ Complete |
| Data Integrity | Emoji stripping (DB indexing), A2A prompt injection scanning (22 patterns) | ✅ Complete |
| Phase 3 — Intelligence | Proactive recall, importance scoring, contradiction detection | 📋 Designed |

---

## Memory Compartments & Knowledge Bases

Every piece of information the agent can store or recall lives in one of these compartments. They differ in volatility, capacity, access speed, and what writes to them.

### Storage Compartments

| ID | Name | Medium | What Lives Here | Written By | Read By | Volatility |
|----|------|--------|----------------|------------|---------|------------|
| C0 | LLM Context Window | In-memory (prompt) | Raw user message only. Agent loads persona via steering (KB0), searches memories via `agentbridge-recall` tool on demand. No bridge-side context injection. | Bridge (raw pass-through) | LLM (every turn) | Ephemeral — rebuilt each turn |
| C1 | Consolidated Summaries | Markdown files | `working/{date}/` (intra-day), `daily/` (daily), `weekly/` (weekly rollups), `quarterly/` (quarterly rollups) | Sleep subagent (via template instructions) | ContextAssembler (last session), MemorySearchTool (compaction LIKE), sleep subagent (consolidation source) | Persistent — promoted up tiers, source deleted after rollup |
| C2 | SQLite + FTS5 | `memory.db` | `messages` + FTS5, `extracted_memories` + dual FTS5, `compactions`, `sessions`, `extraction_watermarks`, `chat_backup` | recordMessage(), MemoryExtractor, agentbridge-store | MemoryIndex, MemorySearchTool, agentbridge-recall, RecallFallbackPipeline | Persistent — pruned by max messages, disk budget, selective forget. chat_backup pruned >7 days on startup |
| C3 | JSONL Transcripts | `transcripts/{chatId}/{sessionId}.jsonl` | Raw message-by-message session logs (role, content, timestamp) | TranscriptWriter | TranscriptParser (restore, parseTail), MemoryExtractor (watermark-based) | Persistent — append-only, one file per session |
| C4 | Markdown Knowledge Files | Flat files | `core/user_profile.md` + `core/agent_notes.md` (agent-maintained), `~/.agentbridge/topics/` (topic summaries) | Agent (proactive writes via steering), topic-save skill (topics) | Sleep subagent (topic reorg) | Persistent — agent-maintained |
| C5 | Vector Index | `memory.db` (`embeddings`) | ONNX embedding vectors per message, model-version-aware | EmbeddingProvider | VectorIndex (cosine similarity), hybridSearch (RRF fusion with FTS5) | Persistent — optional (`MEMORY_VECTOR_ENABLED`), re-embedded on model swap |

### Knowledge Bases

| ID | Name | Backend | Content | Access Method | Scope |
|----|------|---------|---------|---------------|-------|
| KB0 | Soul / Persona | `persona/SOUL.md` | Agent identity, personality, behavioral rules, core truths | Loaded via kiro-cli agent config (`--agent professor`) as steering resource | Static — defines who the agent is |
| KB1 | NotebookLM | Google NotebookLM API | Curated reference documents: research papers, technical docs, guides | `nlm notebook query <id> "question" --json` | External — grounded answers with citations |

### Compartment Data Flow

```
User Message (raw, no bridge-side injection)
    |
    v
+----------+               +----------+
| C0       |    append     | C3       |  JSONL transcript
| LLM      |-------------->| Transcripts
| Context  |               +----------+
|          |                     |
| (agent   |              watermark-based
|  decides |                     v
|  when to |               +----------+    FTS5 auto-index
|  search) |--- recall --->| C2       |<-----------------+
|          |  (via tool)   | SQLite   |                  |
|          |               | + FTS5   |    +----------+  |
|          |               +----------+    | C5       |  |
|          |                     ^         | Vectors  |  |
|          |                     |         +----------+  |
|          |              compaction                      |
|          |                     |              extraction|
|          |               +----------+         +--------+-+
|          |               | C1       |         | Heartbeat |
|          |               | Summaries|         | Extractor |
|          |               +----------+         +-----------+
|          |
|          |<-- soul ------+----------+
|          |   (steering)  | KB0      |
|          |               | Persona  |
+----------+               +----------+

                           +----------+
                           | KB1      |  (queried on-demand,
                           | NLM      |   not part of C0)
                           +----------+
```

---

## System Layer Architecture

The memory system is organized into 7 functional layers, from low-level storage up to overnight maintenance. Each layer builds on the ones below it.

```
+---------------------------------------------------------------------+
|  Layer 7: Overnight Maintenance                                      |
|  agentbridge-sleep, SleepTrigger, SleepStateGatherer,               |
|  sleep-prompt-loader, sleeping_prompt.md template                    |
+---------------------------------------------------------------------+
|  Layer 6: Context Assembly & Prompt Construction (available, not in main path) |
|  ContextAssembler, ContextWindowMonitor                             |
+---------------------------------------------------------------------+
|  Layer 5: Agent-Initiated Recall & Search (agent-driven via steering)  |
|  agentbridge-recall (primary), MemorySearchTool,                     |
|  RecallFallbackPipeline (available, not in main path),               |
|  IntentDetector                                                      |
+---------------------------------------------------------------------+
|  Layer 4: Background Extraction & Enrichment                        |
|  HeartbeatSystem, MemoryExtractor, IngestionPipeline,               |
|  ReflectionEngine, agentbridge-store (Instant Store)                |
+---------------------------------------------------------------------+
|  Layer 3: Consolidation (subagent-driven via sleep template)        |
|  Sleep subagent consolidates working dirs → daily → weekly →        |
|  quarterly per sleeping_prompt.md instructions                      |
+---------------------------------------------------------------------+
|  Layer 2: Indexing & Search Primitives                              |
|  MemoryIndex (FTS5), VectorIndex, EmbeddingProvider                 |
+---------------------------------------------------------------------+
|  Layer 1: Storage & Persistence                                     |
|  SQLite (memory.db), TranscriptWriter, TranscriptParser,            |
|  File System (working/, daily/, weekly/, quarterly/, audit/)        |
+---------------------------------------------------------------------+
```

### Layer 1: Storage & Persistence

Responsible for raw data storage — both structured (SQLite) and unstructured (JSONL files, markdown summaries).

| Component | File | Responsibility |
|-----------|------|----------------|
| SQLite DB | `memory-db.ts` | Schema creation, migrations. 8 tables + 3 FTS5 virtual tables + triggers for auto-indexing |
| TranscriptWriter | `transcript-writer.ts` | Appends JSONL records per session to `transcripts/{chatId}/{sessionId}.jsonl` |
| TranscriptParser | `transcript-parser.ts` | Reads JSONL files, provides `parseTail()` for recent-message loading |
| File System Layout | — | `working/` (intra-day), `daily/`, `weekly/`, `quarterly/`, `audit/`, `core/` |

Data enters this layer via `MemoryManager.recordMessage()` which writes to both JSONL transcript and SQLite `messages` table simultaneously.

### Layer 2: Indexing & Search Primitives

Provides the low-level search interfaces that all higher layers query against.

| Component | File | Responsibility |
|-----------|------|----------------|
| MemoryIndex | `memory-index.ts` | FTS5 BM25 search on `messages_fts`, `extracted_memories_fts`, `extracted_memories_original_fts`. Emotion boost: `final = bm25 + 0.5 * log1p(abs(emotion_score))`. Also handles `index()`, `prune()`, `removeSession()` |
| VectorIndex | `vector-index.ts` | Model-version-aware cosine similarity search. Only active when `MEMORY_VECTOR_ENABLED=true` |
| EmbeddingProvider | `embedding-provider.ts` | Local ONNX embedding generation. Handles model hot-swap via `detectModelChange()` and full re-embedding via `reembed()` |
| sanitizeFtsQuery | `memory-index.ts` | Strips accents, removes FTS5 special characters, normalizes whitespace |

### Layer 3: Consolidation (Subagent-Driven)

Consolidation is performed by the sleep subagent following instructions in `sleeping_prompt.md`. No dedicated compaction engine — the subagent reads raw transcripts and working-dir files, produces consolidated summaries, and promotes them through tiers.

| Source | Target | Threshold | File Naming | Trigger |
|--------|--------|-----------|-------------|---------|
| working dirs | daily | Past-day dirs exist | `daily_YYYYMMDD.md` | Sleep subagent |
| daily | weekly | 7 daily files in same ISO week | `YYYY-Wxx.md` | Sleep subagent |
| weekly | quarterly | 4 weekly files in same quarter | `YYYY-Qn.md` | Sleep subagent |

### Layer 4: Background Extraction & Enrichment

Runs asynchronously in the background to extract structured knowledge from raw conversations and external sources.

| Component | File | Responsibility |
|-----------|------|----------------|
| HeartbeatSystem | `heartbeat-system.ts` | Periodic task runner (default 60s). Error isolation — one failing task doesn't block others |
| MemoryExtractor | `memory-extractor.ts` | LLM extraction: queries unprocessed messages above watermark, batches into ~3K char segments, produces dual-column `content_en` + `content_original` + `emotion_score` [-5,+5]. FTS5 triggers auto-index |
| IngestionPipeline | `ingestion-pipeline.ts` | External document ingestion: YouTube, PDF, text, markdown. Chunks into configurable token sizes |
| ReflectionEngine | `reflection-engine.ts` | LLM-generated topic-clustered meta-summaries |
| agentbridge-store | `cli/agentbridge-store.ts` | Agent-initiated instant memory storage with emotion scoring |

Extraction flow: HeartbeatSystem tick -> MemoryExtractor queries messages above watermark -> batches ~3K chars -> LLM extracts structured JSON -> parsed, validated, inserted into `extracted_memories` -> FTS5 auto-index -> watermark advanced.

### Layer 5: Agent-Initiated Recall & Search

Provides the search interfaces the LLM agent uses to actively retrieve memories during conversation. **The agent drives all recall** — the bridge sends raw user input, and the agent (via `memory-search.md` steering) decides when to search and what keywords to use.

| Component | File | Responsibility |
|-----------|------|----------------|
| MemorySearchTool | `memory-search-tool.ts` | Primary agent search. 5-step pipeline with timeout enforcement (default 1000ms). Graceful degradation at any timeout point |
| agentbridge-recall | `cli/agentbridge-recall.ts` | Standalone CLI invoked by agent via `execute_bash`. 7-stage cascade across all search layers. Opens DB read-only, outputs JSON. **This is the primary recall mechanism.** |
| RecallFallbackPipeline | `recall-fallback-pipeline.ts` | Multi-stage cascade. Available but not used in main prompt path (agent uses agentbridge-recall directly) |
| IntentDetector | `intent-detector.ts` | Detects recall intent from cue phrases, extracts temporal ranges |

MemorySearchTool 5-step pipeline:
1. English FTS5 on `extracted_memories_fts` + compaction LIKE search
2. Original-language FTS5 on `extracted_memories_original_fts` (if `original_keyword` provided)
3. Merge + deduplicate
4. Temporal decay: `score *= 2^(-age_days / halflife_days)` (default 30 days)
5. MMR re-ranking: Jaccard similarity, lambda=0.7

agentbridge-recall 8-stage cascade:
1. FTS5 full-text on messages
2. Relaxed FTS5 (OR-style, drops tokens < 3 chars)
3. Substring LIKE (accent-insensitive)
4. Original-language substring
5. Extracted memories — English FTS5
6. Extracted memories — original language FTS5
7. Compaction summary LIKE
8. chat_backup LIKE fallback (immutable safety table)

### Layer 6: Context Assembly & Prompt Construction

Available infrastructure for token-budgeted context assembly. **Not used in the main Telegram/Discord prompt path** — the bridge sends raw user messages and the agent handles recall via tools. These components remain available for future use or alternative transport modes.

| Component | File | Responsibility |
|-----------|------|----------------|
| ContextAssembler | `context-assembler.ts` | 4-tier assembly with per-tier token budgets. Rolling summary generation, session injection state, recalled memory integration. **Not called from main prompt path.** |
| ContextWindowMonitor | `context-window-monitor.ts` | When `(currentTokens / maxTokens) * 100 > MEMORY_COMPACT_THRESHOLD_PCT` (default 85%), schedules compression via `process.nextTick()` — non-blocking |

ContextAssembler 4-tier assembly:

```
+----------------------------------------------+
| Tier 1: Soul + Core Knowledge                |  500 tokens
|   System prompt + core knowledge             |  user_profile.md + agent_notes.md on session-start
+----------------------------------------------+
| Tier 2: Recalled Memories                    |  600 tokens
|   Last session summary (session-start only)  |
|   Active recall (search-based)               |
+----------------------------------------------+
| Tier 3: Working Memory                       |  2000 tokens
|   Rolling summary (English, LLM-generated)   |  Summary on session-start only
|   + last N messages (rollingBufferSize=20)   |  Prepended with [SESSION START]
+----------------------------------------------+
| Tier 4: New Input                            |
|   Current user message                       |
+----------------------------------------------+
```

Session injection: on first message of a session, tiers 1/2/3 inject extra context (CoreFacts, last session summary, rolling summary). Subsequent messages omit these to save tokens.

### Layer 7: Overnight Maintenance

Automated maintenance cycle during user inactivity. Template-driven: the sleep subagent receives `sleeping_prompt.md` with variable-substituted system state and follows its instructions for consolidation, DB cleanup, disk budget enforcement, and topic reorganization.

| Component | File | Responsibility |
|-----------|------|----------------|
| agentbridge-sleep CLI | `cli/agentbridge-sleep.ts` | Orchestrator: gather state -> load template -> invoke subagent via ACP -> write audit trail |
| SleepTrigger | `sleep-trigger.ts` | Simplified dual triggers: (1) always on startup, (2) heartbeat cron (≥8am, 10min idle, once/day) |
| SleepStateGatherer | `sleep-state-gatherer.ts` | Produces StateSnapshot: working dirs, DB stats, FTS5 integrity, disk usage, topic files, last sleep audit, wakeup date, todo/cron contents, transcript paths |
| sleep-prompt-loader | `sleep-prompt-loader.ts` | Reads `sleeping_prompt.md` template, replaces `${VARIABLES}` with StateSnapshot values |
| sleeping_prompt.md | `persona/sleeping_prompt.md` | Editable template with 6 sections: daily summary, reminder/todo extraction, DB maintenance (with CRITICAL no-delete rule), cron verification, topic reorg, disk budget |

During sleep, the bridge auto-replies "waking up" to incoming messages and queues them. After sleep finishes, queued messages are re-injected through the normal message handler.

---

## File System Layout

All paths relative to `~/.agentbridge/memory/` (configurable via `MEMORY_DIR`).

```
~/.agentbridge/memory/
  memory.db                    # SQLite database
  transcripts/
    {chatId}/
      {sessionId}.jsonl        # Raw JSONL transcript per session
  working/
    {YYYY-MM-DD}/
      transcript_{chatId}.chat   # Full kiro-cli conversation dump (incl. reasoning)
  daily/
    daily_YYYYMMDD.md          # Daily consolidated summaries
  weekly/
    YYYY-Wxx.md                # Weekly rollup summaries (ISO week)
  quarterly/
    YYYY-Qn.md                 # Quarterly rollup summaries
  core/
    user_profile.md              # Who the user is (agent-maintained)
    agent_notes.md               # Environment facts, lessons learned (agent-maintained)
  audit/
    sleep_YYYYMMDD_HHmmss.md   # Sleep cycle audit trail logs
  (legacy: monthly/, yearly/, scratchpads/, {chatId}/user_core_facts.md -- preserved, not actively written)
```

Additional deployed files:
- `~/.agentbridge/sleeping_prompt.md` — sleep template (copied by `deploy.sh`)

---

## Architecture

```
src/
  types/
    memory.ts              # All memory types
    index.ts               # Re-exports
  components/
    memory-config.ts       # MemoryConfig type + loadMemoryConfig()
    memory-db.ts           # SQLite schema creation + migrations
    memory-manager.ts      # Top-level coordinator
    memory-index.ts        # FTS5 search + emotion boost
    memory-search-tool.ts  # Agent-initiated recall with decay + MMR
    memory-extractor.ts    # LLM-based extraction with emotion scoring
    emotion-utils.ts       # clampEmotionScore() utility
    heartbeat-system.ts    # Periodic background task runner
    context-window-monitor.ts # Threshold-based async compression
    transcript-writer.ts   # JSONL append
    transcript-parser.ts   # JSONL read + parseTail()
    sleep-trigger.ts       # Sleep trigger logic (always startup + cron)
    sleep-state-gatherer.ts # System state snapshot
    sleep-prompt-loader.ts # Template loader replacing SleepPromptBuilder
    context-assembler.ts   # 4-tier context + rolling summary
    embedding-provider.ts  # Local ONNX embeddings + hot-swap
    vector-index.ts        # Model-version-aware cosine similarity
    ingestion-pipeline.ts  # YouTube/PDF/text/markdown ingestion
    reflection-engine.ts   # LLM-generated meta-summaries
    prompt-scanner.ts      # A2A prompt injection scanning (22 patterns)
    recall-fallback-pipeline.ts # Multi-stage search cascade
    intent-detector.ts     # Recall intent + temporal range detection
  cli/
    agentbridge-sleep.ts   # Sleep CLI (overnight maintenance)
    agentbridge-recall.ts  # Agent-initiated memory search (8-stage cascade)
    agentbridge-store.ts   # Agent-initiated instant storage
  persona/
    sleeping_prompt.md     # Editable sleep template with ${VARIABLE} substitution
  skills/
    memory-search/SKILL.md
    instant-store/SKILL.md
  main.ts                  # Transport wiring, command handlers, sleep trigger
```

---

## Component Inventory

### Foundation (Phase 1)

| Component | File | Notes |
|-----------|------|-------|
| Core types | `types/memory.ts` | All memory types |
| MemoryConfig | `components/memory-config.ts` | 20+ config fields incl. heartbeat, searchEnhancements, dayBoundaryHours |
| TranscriptWriter | `components/transcript-writer.ts` | JSONL append per session |
| TranscriptParser | `components/transcript-parser.ts` | JSONL read + parseTail() |
| SQLite schema | `components/memory-db.ts` | 9 tables + 3 FTS5 virtual tables + triggers + migrations (incl. chat_backup) |
| MemoryIndex | `components/memory-index.ts` | BM25 search, prune, removeSession, searchExtracted, searchOriginal, emotion boost |
| EmbeddingProvider | `components/embedding-provider.ts` | ONNX embeddings, model versioning, reembed |
| VectorIndex | `components/vector-index.ts` | Model-version-aware cosine similarity |
| ContextAssembler | `components/context-assembler.ts` | 4-tier assembly + English rolling summary + session injection |
| MemoryManager | `components/memory-manager.ts` | Coordinator for all subsystems |
| main.ts | `main.ts` | Telegram + Discord wiring, sleep trigger integration |

### Commands (Phase 2)

| Component | File | Notes |
|-----------|------|-------|
| IngestionPipeline | `components/ingestion-pipeline.ts` | YouTube, PDF, text, markdown |
| ReflectionEngine | `components/reflection-engine.ts` | LLM-generated topic-clustered digests |
| Embedding Hot-Swap | `components/embedding-provider.ts` | detectModelChange + reembed |
| Selective Forgetting | `components/memory-manager.ts` | cascadeDelete, forgetTopic/Range/Session |

### Search Enhancements

| Component | File | Notes |
|-----------|------|-------|
| HeartbeatSystem | `components/heartbeat-system.ts` | Periodic background tasks with error isolation |
| MemoryExtractor | `components/memory-extractor.ts` | LLM extraction with dual-column English + original + emotion |
| MemorySearchTool | `components/memory-search-tool.ts` | Agent recall with temporal decay + MMR diversity |
| ContextWindowMonitor | `components/context-window-monitor.ts` | Threshold-based async compression |
| RecallFallbackPipeline | `components/recall-fallback-pipeline.ts` | Multi-stage cascade (primary->context->relaxed->substring->vector) |
| IntentDetector | `components/intent-detector.ts` | Recall intent + temporal range detection |

### Instant Memory Store

| Component | File | Notes |
|-----------|------|-------|
| agentbridge-store CLI | `cli/agentbridge-store.ts` | `--content-en`, `--content-original`, `--memory-type`, `--emotion-score`, `--chat-id`, `--keyword` |
| MemoryManager.instantStore() | `components/memory-manager.ts` | Validates, clamps emotion, inserts, advances watermark |
| clampEmotionScore | `components/emotion-utils.ts` | Shared clamping to [-5,+5] |
| Emotion-boosted ranking | `components/memory-index.ts` | `0.5 * log1p(abs(emotion_score))` additive boost |

### Sleep CLI (Overnight Maintenance)

| Component | File | Notes |
|-----------|------|-------|
| agentbridge-sleep CLI | `cli/agentbridge-sleep.ts` | Orchestrator: gather state -> load template -> invoke subagent -> audit |
| SleepTrigger | `components/sleep-trigger.ts` | Always on startup + heartbeat cron (≥8am, 10min idle, once/day) |
| SleepStateGatherer | `components/sleep-state-gatherer.ts` | Scans working dirs, DB stats, FTS5 health, disk usage, topic files, last sleep audit, transcript paths |
| sleep-prompt-loader | `components/sleep-prompt-loader.ts` | Reads sleeping_prompt.md template, replaces ${VARIABLES} with StateSnapshot values |
| sleeping_prompt.md | `persona/sleeping_prompt.md` | Editable template: daily summary, reminders, DB maintenance, cron, topics, disk budget |
| chat_backup table | `components/memory-db.ts` | Immutable copy of all messages, pruned >7 days on startup by wired logic |

### Data Integrity

| Component | File | Notes |
|-----------|------|-------|
| stripEmojis | `components/memory-manager.ts` | Strips `\p{Emoji_Presentation}` and `\p{Extended_Pictographic}` from message content before DB/FTS5 indexing. JSONL transcripts retain raw emojis for audit. Emotion captured via `emotion_score`, not glyphs |
| PromptScanner | `components/prompt-scanner.ts` | 22 compiled regex patterns in 3 categories (prompt injection 14, exfiltration 5, destructive 3) + 10 invisible unicode chars. `scanPrompt(text)` returns `null` if clean or `{ patternId, matched }` if blocked |
| A2A scan integration | `components/agent-api-server.ts` | Calls `scanPrompt()` in `handlePrompt()` after body parsing, before transport spawn. On match: HTTP 200 with graceful refusal message (not 4xx), no kiro-cli spawn, blocked content never enters memory DB |

### Phase 3 -- Intelligence (Designed, Not Implemented)

Proactive Recall, ImportanceScorer, ContradictionDetector, Cross-Channel Linking, FeedbackTracker, Topic-Based Chunking.

---

## Configuration

All env vars with defaults from `memory-config.ts` and `sleep-trigger.ts`:

| Env Var | Default | Description |
|---------|---------|-------------|
| `MEMORY_ENABLED` | `true` | Enable/disable entire memory layer |
| `MEMORY_DIR` | `~/.agentbridge/memory` | Root directory for all memory files |
| `MEMORY_MAX_MESSAGES_PER_CHAT` | `1000` | Max messages per chat before pruning |
| `MEMORY_DISK_BUDGET_MB` | `500` | Disk budget in MB |
| `MEMORY_VECTOR_ENABLED` | `false` | Enable local ONNX vector search |
| `MEMORY_STALENESS_HOURS` | `24` | Session staleness threshold |
| `MEMORY_RESTORE_MESSAGES` | `50` | Messages to restore on session resume |
| `MEMORY_COMPACT_ON_RESET` | `false` | Compact on `/reset` |
| `MEMORY_AUTO_COMPACT_THRESHOLD` | `3000` | Token threshold for auto-compact (legacy) |
| `MEMORY_COMPACT_THRESHOLD_PCT` | `85` | Context window % to trigger auto-compact |
| `MEMORY_CONTEXT_BUDGET_SOUL` | `500` | Token budget: soul tier |
| `MEMORY_CONTEXT_BUDGET_RECALLED` | `600` | Token budget: recalled memories tier |
| `MEMORY_CONTEXT_BUDGET_WORKING` | `2000` | Token budget: working memory tier |
| `MEMORY_ROLLING_BUFFER_SIZE` | `20` | Recent messages kept in full detail |
| `MEMORY_INGEST_CHUNK_MAX_TOKENS` | `512` | Max tokens per ingestion chunk |
| `MEMORY_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Embedding model name |
| `MEMORY_FORGET_THRESHOLD` | `0.8` | Relevance threshold for topic forgetting |
| `MEMORY_RECALL_FALLBACK_ENABLED` | `true` | Enable recall fallback pipeline |
| `MEMORY_RECALL_FALLBACK_TIMEOUT_MS` | `500` | Recall fallback timeout |
| `MEMORY_RECALL_CONTEXT_MESSAGES` | `5` | Context messages for recall |
| `MEMORY_RECALL_MIN_TOKEN_LENGTH` | `3` | Min token length for recall |
| `MEMORY_RECALL_CUE_PHRASES` | (built-in) | JSON override for cue phrases |
| `MEMORY_HEARTBEAT_ENABLED` | `true` | Enable heartbeat background tasks |
| `MEMORY_HEARTBEAT_INTERVAL_MS` | `300000` | Heartbeat tick interval (5min) |
| `MEMORY_SEARCH_TIMEOUT_MS` | `1000` | Search timeout |
| `MEMORY_DECAY_HALFLIFE_DAYS` | `30` | Temporal decay half-life |
| `MEMORY_MMR_LAMBDA` | `0.7` | MMR diversity parameter |
| `MEMORY_DAY_BOUNDARY_HOURS` | `4` | Inactivity gap for day boundary (legacy, unused by new sleep trigger) |

---

## Data Flow

### Message Processing Pipeline

1. **Startup**: `main.ts` -> `loadMemoryConfig()` -> `MemoryManager.initialize()` -> opens SQLite, creates schema, optionally loads embedding model, initializes IngestionPipeline + ReflectionEngine
2. **LLM Callback**: `memory.setLlmCall(...)` wires transport for compaction, context assembly, reflections, extraction
3. **Heartbeat Start**: `memory.startHeartbeat()` registers memory-extraction + consolidation + sleep-trigger cron tasks
4. **Sleep Startup Check**: `SleepTrigger.shouldRunOnStartup()` always returns true -> spawns `agentbridge-sleep.js` detached. During sleep, incoming messages get auto-reply ("waking up") and are queued. After sleep finishes, queued messages are re-injected.
5. **Message In**: `memory.recordMessage()` -> JSONL append (raw, with emojis) -> `stripEmojis()` on content -> FTS5 index (emoji-free) -> insert into `chat_backup` (immutable copy) -> optional vector index -> prune -> disk budget check every 100 writes
6. **Background Extraction** (heartbeat): MemoryExtractor queries unprocessed transcripts -> LLM extracts structured memories with emotion scores -> dual-column `content_en` + `content_original` -> FTS5 auto-index -> watermark advanced
7. **Instant Storage**: Agent invokes `agentbridge-store` CLI -> validates -> clamps emotion -> inserts `extracted_memories` -> advances watermark
8. **Prompt Path**: Bridge sends raw user message to kiro-cli (no context injection). Agent reads `memory-search.md` steering, decides if recall is needed, invokes `agentbridge-recall` via `execute_bash` with extracted keywords. ContextAssembler (4-tier) exists but is not used in the main Telegram/Discord prompt path.
8b. **A2A Prompt Scanning**: Inbound A2A messages pass through `scanPrompt()` before transport spawn. 22 regex patterns + invisible unicode detection. On match: HTTP 200 with graceful refusal, no kiro-cli spawn, no memory recording. Blocked content never enters C2/C3.
9. **Agent Search**: `agentbridge-recall` -> 8-stage cascade (FTS5 AND -> relaxed OR -> substring -> original-language -> extracted memories EN -> extracted memories original -> compactions -> chat_backup) -> merge + deduplicate -> temporal decay -> MMR re-ranking
10. **Idle Chat Save**: After 10min inactivity, bridge sends `/chat save` to kiro-cli, dumping full conversation (incl. reasoning) to `working/{date}/transcript_{chatId}.chat`. Also triggered before `/reset`. A2A sessions save `transcript_a2a.chat` before idle timeout kill.
11. **Auto-Compaction**: When context window exceeds `MEMORY_COMPACT_THRESHOLD_PCT` (default 85%), writes safety-net transcript to working dir, sends `/compact` to Kiro CLI
12. **Consolidation** (sleep subagent): Follows `sleeping_prompt.md` template instructions. Working dirs -> daily, 7 daily -> weekly, 4 weekly -> quarterly. English summaries.
13. **Sleep Cycle** (startup or cron): SleepTrigger fires -> `agentbridge-sleep` gathers state -> loads template with variable substitution -> invokes subagent via ACP -> subagent performs maintenance -> audit trail written
14. **Shutdown**: `memory.stopHeartbeat()` -> `memory.close()`

### Sleep Cycle Flow

The sleep cycle is the maintenance routine. It runs via two triggers:

**Trigger 1 -- Startup** (`main.ts`):
- `SleepTrigger.shouldRunOnStartup()` always returns true
- Spawns `agentbridge-sleep.js` as detached child process
- Sets `sleepChild` — incoming messages during sleep get auto-reply ("Oh good morning, I am just waking up, give me a minute please.. I answer you soon ☕") and are queued in `pendingMessages`
- On sleep exit, queued messages are re-injected via `telegramPoller.injectUpdate()`

**Trigger 2 -- Internal cron** (`memory-manager.ts` heartbeat):
- Registered as heartbeat task, checked every tick (default 5min)
- `SleepTrigger.shouldRunFromCron(lastMessageTs)` checks all three:
  - Hour ≥ 8
  - Last message > 10min ago
  - No audit file for today's date
- If true, spawns `agentbridge-sleep.js` as detached child process

**Sleep CLI Execution** (`agentbridge-sleep.ts`):
1. Initialize MemoryManager (opens DB, runs `pruneBackup()` to delete chat_backup rows >7 days)
2. `SleepStateGatherer.gather()` -> scans working dirs, queries DB stats, checks FTS5 integrity, calculates disk usage, lists topic files, reads last sleep audit, determines wakeup date, reads todo/cron contents, lists transcript paths
3. `loadSleepPrompt(snapshot)` -> reads `sleeping_prompt.md` template (from `~/.agentbridge/` deployed or `persona/` dev), replaces `${VARIABLES}` with StateSnapshot values
4. `--dry-run`: prints prompt to stdout and exits
5. Normal mode: invokes subagent via ACP transport (model priority: Opus 4 -> Sonnet 4 -> Sonnet 3.5)
6. Writes audit trail to `~/.agentbridge/memory/audit/sleep_YYYYMMDD_HHmmss.md`

**sleeping_prompt.md template sections:**
- §1 Daily Summary — consolidate working dirs into daily files
- §2 Reminder & Todo Extraction — extract actionable items
- §3 Database Maintenance — FTS5 repair, orphan cleanup, VACUUM/ANALYZE. CRITICAL SAFETY RULE: DO NOT delete any rows from messages or chat_backup
- §4 Cron Verification — check scheduled tasks
- §5 Topic Reorg — merge duplicates, update stale, delete empty
- §6 Disk Budget — enforce size limits

**chat_backup safety table:**
- Every message recorded via `recordMessage()` is also inserted into `chat_backup`
- Immutable — the LLM is instructed never to delete from it
- Pruned by wired logic only: `pruneBackup()` deletes rows >7 days on startup
- Searchable as Stage 8 fallback in `agentbridge-recall` (LIKE search)

### Command Handlers

| Command | Description |
|---------|-------------|
| `/new`, `/reset` | Reset session, clear buffer |
| `/status` | Connection status + uptime + context % |
| `/stop`, `/cancel` | Ctrl+C interrupt |
| `/compact` | Handled by sleep cycle (returns info message) |
| `/facts` | Display user core facts |
| `/memory` | Memory stats (messages, extracted, compactions, disk, heartbeat, NotebookLM) |
| `/ingest <url>` | Ingest YouTube/PDF/text/markdown |
| `/ingest list` | List ingested documents |
| `/reflect [days]` | Generate LLM reflection |
| `/reflect list` | List past reflections |
| `/reembed` | Re-embed all content with current model |
| `/forget topic <t>` | Semantic forget |
| `/forget range <s> <e>` | Date-range forget |
| `/forget session <id>` | Session forget |
| `/full` | Raw output mode |
| `/short` | Clean output mode |
| `/restart` | Restart Kiro (tmux only) |

---

## Key Implementation Details

### Auto-Compaction (Percentage-Based)

Triggered when context window usage exceeds `MEMORY_COMPACT_THRESHOLD_PCT` (default 85%). The `checkAutoCompact()` method in MemoryManager:
1. Writes raw transcript to `working/{YYYY-MM-DD}/transcript_{chatId}.chat` as safety net
2. Sends `/compact` command to Kiro CLI agent for LLM summarization

### Emotion Scoring

- Integer [-5, +5] on `extracted_memories.emotion_score`
- Scale: -5=angry, -3=frustrated, -1=slightly negative, 0=neutral, +1=slightly positive, +3=pleased, +5=happy
- Assessed by agent (instant store) and LLM (heartbeat extraction)
- Search boost: `final_score = bm25_score + 0.5 * log1p(abs(emotion_score))`

### LLM Callback Wiring

Single callback registered in `main.ts`: `memory.setLlmCall((prompt, content) => transport.sendPrompt("system:memory", ...))`. Flows to ContextAssembler, ReflectionEngine, MemoryExtractor. All consumers handle null gracefully.

### Consolidation Tiers

| Source | Target | Threshold | File Naming |
|--------|--------|-----------|-------------|
| working dirs | daily | Past-day dirs (sleep subagent) | `daily_YYYYMMDD.md` |
| daily | weekly | 7 daily files in same ISO week (sleep subagent) | `YYYY-Wxx.md` |
| weekly | quarterly | 4 weekly files in same quarter (sleep subagent) | `YYYY-Qn.md` |
| (legacy monthly/yearly preserved but not actively written) | | | |

---

## CLI Tools

### agentbridge-sleep

Overnight maintenance orchestrator. Thin CLI that gathers state, loads template, invokes subagent.

```
agentbridge sleep [--dry-run] [--verbose]
```

- `--dry-run`: Gather state + load template, print to stdout, skip subagent
- `--verbose`: Detailed logging at each phase
- Exit 0 on success, 1 on fatal error
- Always uses ACP transport (never tmux)
- Model priority: `claude-opus-4-0-20250514` -> `claude-sonnet-4-20250514` -> `claude-sonnet-3-5-20241022`
- Template: `~/.agentbridge/sleeping_prompt.md` (deployed) or `persona/sleeping_prompt.md` (dev)
- Audit trail: `~/.agentbridge/memory/audit/sleep_YYYYMMDD_HHmmss.md`
- `package.json` bin: `"agentbridge-sleep": "dist/cli/agentbridge-sleep.js"`

### agentbridge-recall

Agent-initiated memory search across 4 layers + compactions + chat_backup (8-stage cascade).

### agentbridge-store

Agent-initiated instant memory storage with emotion scoring.

---

## Test Coverage

600 tests across 56 test files. All passing.

---

## Deployment

`scripts/deploy.sh` builds TypeScript, copies dist + node_modules + package.json to `~/.agentbridge/`, copies `sleeping_prompt.md` to `~/.agentbridge/`, and links all bin entries including `agentbridge-sleep`.
