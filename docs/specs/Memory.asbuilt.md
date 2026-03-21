# Local Memory — As-Built Documentation

## Overview

The local memory layer provides SQLite-backed persistence, JSONL transcript files, FTS5 full-text search, optional local-model vector search, external document ingestion, LLM-generated reflections, embedding model hot-swap, selective forgetting, sleep-subagent-driven extraction with English-normalized dual-column storage, agent-initiated memory search with temporal decay and MMR diversity, agent-initiated instant memory storage with emotion scoring, emotion-boosted search ranking, an automated sleep maintenance cycle with template-based subagent instructions and 7-step garbage collection, immutable chat_backup safety table, emoji stripping before DB indexing, regex-based prompt injection scanning on A2A inbound messages, Telegram reaction-to-emotion scoring via platform message ID tracking, Memory Darwinism (recall tracking, relevance scoring, confidence, fitness-based pruning, memory merging), source message linking with expand CLI, large message interception with overflow files, NATO-style memory confidentiality classification (UNCLASSIFIED/RESTRICTED/CONFIDENTIAL/SECRET), and NATO Admiralty Code-inspired trust (source reliability), integrity (provenance), and credibility (information accuracy) per-memory fields with trust-weighted ranking and action gating.

**Recall architecture**: The bridge does NOT inject recalled memories or context into the prompt. The LLM agent handles all recall autonomously — it reads the `memory-search.md` steering file, decides when to search, extracts relevant keywords from user input, and invokes `agentbridge-recall` via `execute_bash`. This leverages the LLM's natural language understanding for keyword extraction instead of a heuristic pipeline.

### Phase Summary

| Phase | Scope | Status |
|-------|-------|--------|
| Phase 1 — Foundation | LLM compaction, context assembly, rolling summary | ✅ Complete |
| Phase 2 — Commands | `/ingest`, `/reflect`, `/reembed`, `/forget` | ✅ Complete |
| Search Enhancements | English-normalized storage, agent recall, temporal decay, MMR | ✅ Complete |
| Instant Memory Store | Agent-initiated storage, emotion scoring, emotion-boosted ranking | ✅ Complete |
| Sleep CLI | Automated overnight maintenance: state gathering, subagent-driven cleanup, audit trail | ✅ Complete |
| Sleep GC | 7-step garbage collection: purge expired, immediate deletes, emotion harvest, noise mark, repeated probes, verify-extract-mark, audit report | ✅ Complete |
| Data Integrity | Emoji stripping (DB indexing), A2A prompt injection scanning (22 patterns) | ✅ Complete |
| Reaction Scoring | Telegram emoji reactions → emotion_score on messages via platform_message_id | ✅ Complete |
| Memory Darwinism | Recall tracking (recall_count, last_recalled_at), relevance scoring, confidence, ranking boost, memory merging, fitness-based pruning | ✅ Complete |
| LCM Enhancements | Source message linking (source_message_ids), agentbridge-expand CLI, large message interception (overflow files) | ✅ Complete |
| Memory Confidentiality | NATO classification (0=UNCLASSIFIED, 1=RESTRICTED, 2=CONFIDENTIAL, 3=SECRET), search filtering, reclassify with SECRET guard, A2A recall=UNCLASSIFIED only | ✅ Complete |
| NATO Admiralty Code | Per-memory trust (source reliability 0-3), integrity (provenance 0-3), credibility (info accuracy 1-6), trust-weighted ranking boost, action gating skill, merge auto-sets integrity=compacted | ✅ Complete |
| Phase 3 — Intelligence | Proactive recall, importance scoring, contradiction detection | 📋 Designed |

---

## Memory Compartments & Knowledge Bases

Every piece of information the agent can store or recall lives in one of these compartments. They differ in volatility, capacity, access speed, and what writes to them.

### Storage Compartments

| ID | Name | Medium | What Lives Here | Written By | Read By | Volatility |
|----|------|--------|----------------|------------|---------|------------|
| C0 | LLM Context Window | In-memory (prompt) | Raw user message only. Agent loads persona via steering (KB0), searches memories via `agentbridge-recall` tool on demand. No bridge-side context injection. | Bridge (raw pass-through) | LLM (every turn) | Ephemeral — rebuilt each turn |
| C1 | Consolidated Summaries | Markdown files | `working/{date}/` (intra-day), `daily/` (daily), `weekly/` (weekly rollups), `quarterly/` (quarterly rollups) | Sleep subagent (via template instructions) | ContextAssembler (last session), consolidation-search.ts (file-based keyword search), sleep subagent (consolidation source) | Persistent — promoted up tiers, source deleted after rollup |
| C2 | SQLite + FTS5 | `memory.db` | `messages` + FTS5, `extracted_memories` + dual FTS5, `sessions`, `extraction_watermarks`, `chat_backup` | recordMessage(), MemoryExtractor, agentbridge-store | MemoryIndex, MemorySearchTool, agentbridge-recall, RecallFallbackPipeline | Persistent — pruned by max messages, disk budget, selective forget. chat_backup pruned >7 days on startup |
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
|          |            consolidation                      |
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
|  MemoryExtractor (class exists, not wired), IngestionPipeline,      |
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
| SQLite DB | `memory-db.ts` | Schema creation, migrations. 8 tables + 3 FTS5 virtual tables + triggers for auto-indexing. `messages` table includes `platform_message_id` (Telegram message_id for reaction lookup) and `emotion_score` (set by reaction handler) |
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

Consolidation is performed by the sleep subagent following instructions in `sleeping_prompt.md`. No dedicated consolidation engine — the subagent reads raw transcripts and working-dir files, produces consolidated summaries, and promotes them through tiers.

| Source | Target | Threshold | File Naming | Trigger |
|--------|--------|-----------|-------------|---------|
| working dirs | daily | Past-day dirs exist | `daily_YYYYMMDD.md` | Sleep subagent |
| daily | weekly | 7 daily files in same ISO week | `YYYY-Wxx.md` | Sleep subagent |
| weekly | quarterly | 4 weekly files in same quarter | `YYYY-Qn.md` | Sleep subagent |

### Layer 4: Background Extraction & Enrichment

Runs asynchronously in the background to extract structured knowledge from raw conversations and external sources.

| Component | File | Responsibility |
|-----------|------|----------------|
| HeartbeatSystem | `heartbeat-system.ts` | Unified periodic task runner (5-min interval, owned by `main.ts`). 4 tasks: `sleep-trigger`, `cron-checker`, `browse-checker`, `reminder-injector`. Error isolation — one failing task doesn't block others |
| MemoryExtractor | `memory-extractor.ts` | LLM extraction: queries unprocessed messages above watermark, batches into ~3K char segments, produces dual-column `content_en` + `content_original` + `emotion_score` [-5,+5]. FTS5 triggers auto-index. **Not wired into heartbeat** — extraction is driven by sleep subagent (§6 verify-extract-mark) and agent-initiated `agentbridge-store` |
| IngestionPipeline | `ingestion-pipeline.ts` | External document ingestion: YouTube, PDF, text, markdown. Chunks into configurable token sizes |
| ReflectionEngine | `reflection-engine.ts` | LLM-generated topic-clustered meta-summaries |
| agentbridge-store | `cli/agentbridge-store.ts` | Agent-initiated instant memory storage with emotion scoring |

Extraction flow: Sleep subagent §6 (verify-extract-mark) checks if conversation facts exist in `extracted_memories`, extracts missing via `agentbridge-store`, then garbage-marks verbose originals. Agent also invokes `agentbridge-store` directly during conversation for instant storage with emotion scoring.

### Layer 5: Agent-Initiated Recall & Search

Provides the search interfaces the LLM agent uses to actively retrieve memories during conversation. **The agent drives all recall** — the bridge sends raw user input, and the agent (via `memory-search.md` steering) decides when to search and what keywords to use.

| Component | File | Responsibility |
|-----------|------|----------------|
| MemorySearchTool | `memory-search-tool.ts` | Primary agent search. 5-step pipeline with timeout enforcement (default 1000ms). Graceful degradation at any timeout point |
| agentbridge-recall | `cli/agentbridge-recall.ts` | Standalone CLI invoked by agent via `execute_bash`. 7-stage cascade across all search layers. Opens DB read-only, outputs JSON. **This is the primary recall mechanism.** |
| RecallFallbackPipeline | `recall-fallback-pipeline.ts` | Multi-stage cascade. Available but not used in main prompt path (agent uses agentbridge-recall directly) |
| IntentDetector | `intent-detector.ts` | Detects recall intent from cue phrases, extracts temporal ranges |

MemorySearchTool 5-step pipeline:
1. English FTS5 on `extracted_memories_fts` + consolidation file search (via consolidation-search.ts)
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
7. Consolidation file keyword search
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
| SleepTrigger | `sleep-trigger.ts` | Dual triggers with retry: (1) startup if no audit today, (2) heartbeat cron (≥8am, 10min idle). On failure: retry next HB, then after 1h cooldown. Max 3 attempts/day |
| SleepStateGatherer | `sleep-state-gatherer.ts` | Produces StateSnapshot: working dirs, DB stats, FTS5 integrity, disk usage, topic files, last sleep audit, wakeup date, todo/cron contents, transcript paths |
| sleep-prompt-loader | `sleep-prompt-loader.ts` | Reads `sleeping_prompt.md` template, replaces `${VARIABLES}` with StateSnapshot values |
| sleeping_prompt.md | `persona/sleeping_prompt.md` | Editable template with 7 sections: daily summary, reminder/todo extraction, garbage collection (7-step GC protocol), cron verification, topic reorg, disk budget, audit report |

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
- `~/.agentbridge/garbage.json` — GC grace-period tracking (created by sleep subagent)

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
    emotion-utils.ts       # clampEmotionScore() + emojiToScore() utilities
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
    consolidation-search.ts  # File-based search on daily/weekly/quarterly .md files (replaces compactions table)
    intent-detector.ts     # Recall intent + temporal range detection
  cli/
    agentbridge-sleep.ts   # Sleep CLI (overnight maintenance)
    agentbridge-recall.ts  # Agent-initiated memory search (8-stage cascade)
    agentbridge-store.ts   # Agent-initiated instant storage
    agentbridge-expand.ts  # Source message lookup by ID
  persona/
    sleeping_prompt.md     # Editable sleep template with ${VARIABLE} substitution
  skills/
    memory-search/SKILL.md   # Recall skill — keywords, source_ids output, expand workflow
    instant-store/SKILL.md   # Store skill — emotion, confidence, classification
    classification/SKILL.md  # NATO classification auto-trigger rules, context-based disclosure
    trust-gating/SKILL.md    # Action authorization rules per trust level
  components/
    message-interceptor.ts   # Large message interception → overflow files
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
| main.ts | `main.ts` | Telegram + Discord wiring, unified heartbeat (4 tasks), sleep trigger integration |

### Commands (Phase 2)

| Component | File | Notes |
|-----------|------|-------|
| IngestionPipeline | `components/ingestion-pipeline.ts` | YouTube, PDF, text, markdown |
| ReflectionEngine | `components/reflection-engine.ts` | LLM-generated topic-clustered digests |
| Embedding Hot-Swap | `components/embedding-provider.ts` | detectModelChange + reembed |
| Selective Forgetting | `components/memory-manager.ts` | cascadeDelete (DB + JSONL + embeddings + FTS5), forgetTopic/Range/Session |

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
| agentbridge-store CLI | `cli/agentbridge-store.ts` | `--content-en`, `--content-original`, `--memory-type`, `--emotion-score`, `--chat-id`, `--keyword`, `--boost`/`--demote --id`, `--merge --merge-ids`, `--reclassify --id --classification`, `--delete-ids --chat-id` |
| MemoryManager.instantStore() | `components/memory-manager.ts` | Validates, clamps emotion, inserts, advances watermark |
| clampEmotionScore | `components/emotion-utils.ts` | Shared clamping to [-5,+5] |
| emojiToScore | `components/emotion-utils.ts` | Maps Telegram reaction emojis to [-5,+5] scores |
| Emotion-boosted ranking | `components/memory-index.ts` | `0.5 * log1p(abs(emotion_score))` additive boost |

### Sleep CLI (Overnight Maintenance)

| Component | File | Notes |
|-----------|------|-------|
| agentbridge-sleep CLI | `cli/agentbridge-sleep.ts` | Orchestrator: gather state -> load template -> invoke subagent -> audit |
| SleepTrigger | `components/sleep-trigger.ts` | Dual triggers with retry: (1) startup if no audit today, (2) heartbeat cron (≥8am, 10min idle). Max 3 attempts/day, 1h cooldown after 2nd failure |
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
| `MEMORY_HEARTBEAT_INTERVAL_MS` | `300000` | Heartbeat tick interval (5min). **Note:** currently overridden by main.ts which creates its own HeartbeatSystem at 5min. These config values are unused. |
| `MEMORY_SEARCH_TIMEOUT_MS` | `1000` | Search timeout |
| `MEMORY_DECAY_HALFLIFE_DAYS` | `30` | Temporal decay half-life |
| `MEMORY_MMR_LAMBDA` | `0.7` | MMR diversity parameter |
| `MEMORY_DAY_BOUNDARY_HOURS` | `4` | Inactivity gap for day boundary (legacy, unused by new sleep trigger) |

---

## Data Flow

### Message Processing Pipeline

1. **Startup**: `main.ts` -> `loadMemoryConfig()` -> `MemoryManager.initialize()` -> opens SQLite, creates schema, optionally loads embedding model, initializes IngestionPipeline + ReflectionEngine. Runs `checkTranscriptDbDrift()` to warn if JSONL line count diverges from DB row count (Δ>10).
2. **LLM Callback**: `memory.setLlmCall(...)` wires transport for context assembly, reflections, extraction
3. **Heartbeat Start**: `main.ts` creates a unified `HeartbeatSystem` (5-min interval) with 4 tasks: `sleep-trigger`, `cron-checker`, `browse-checker`, `reminder-injector`. Passes reference to memory via `memory.setHeartbeat()`
4. **Sleep Startup Check**: `SleepTrigger.shouldRunOnStartup()` runs if no audit today (or >25h since last) -> spawns `agentbridge-sleep.js` detached. On exit, reports success/failure back to SleepTrigger for retry logic. During sleep, incoming messages get auto-reply ("waking up") and are queued. After sleep finishes, queued messages are re-injected.
5. **Message In**: `memory.recordMessage()` -> JSONL append (raw, with emojis) -> `stripEmojis()` on content -> FTS5 index (emoji-free, with `platform_message_id`) -> insert into `chat_backup` (immutable copy) -> optional vector index -> prune -> disk budget check every 100 writes
5b. **Telegram Reaction**: Authorized user reacts to message -> `emojiToScore(emoji)` -> `memory.updateEmotionByPlatformId(chatId, messageId, score)` -> updates `messages.emotion_score` on the row matching `platform_message_id`
6. **Background Extraction** (sleep subagent + instant store): Sleep subagent's §6 (verify-extract-mark) checks if conversation facts exist in `extracted_memories`, extracts missing via `agentbridge-store`. Agent also invokes `agentbridge-store` directly during conversation for instant storage. **Note:** `MemoryExtractor` class exists but is not registered as a heartbeat task — extraction is subagent-driven, not background-driven.
7. **Instant Storage**: Agent invokes `agentbridge-store` CLI -> validates -> clamps emotion -> inserts `extracted_memories` -> advances watermark
8. **Prompt Path**: Bridge sends raw user message to kiro-cli (no context injection). Agent reads `memory-search.md` steering, decides if recall is needed, invokes `agentbridge-recall` via `execute_bash` with extracted keywords. ContextAssembler (4-tier) exists but is not used in the main Telegram/Discord prompt path.
8b. **A2A Prompt Scanning**: Inbound A2A messages pass through `scanPrompt()` before transport spawn. 22 regex patterns + invisible unicode detection. On match: HTTP 200 with graceful refusal, no kiro-cli spawn, no memory recording. Blocked content never enters C2/C3.
9. **Agent Search**: `agentbridge-recall` -> 8-stage cascade (FTS5 AND -> relaxed OR -> substring -> original-language -> extracted memories EN -> extracted memories original -> consolidation files -> chat_backup) -> merge + deduplicate -> temporal decay -> MMR re-ranking
10. **Idle Chat Save**: After 10min inactivity, bridge sends `/chat save` to kiro-cli, dumping full conversation (incl. reasoning) to `working/{date}/transcript_{chatId}.chat`. Also triggered before `/reset`. A2A sessions save `transcript_a2a.chat` before idle timeout kill.
11. **Auto-Compaction**: When context window exceeds `MEMORY_COMPACT_THRESHOLD_PCT` (default 85%), writes safety-net transcript to working dir, sends `/compact` to Kiro CLI
12. **Consolidation** (sleep subagent): Follows `sleeping_prompt.md` template instructions. Working dirs -> daily, 7 daily -> weekly, 4 weekly -> quarterly. English summaries.
13. **Sleep Cycle** (startup or cron): SleepTrigger fires -> `agentbridge-sleep` gathers state -> loads template with variable substitution -> invokes subagent via ACP -> subagent performs maintenance -> audit trail written
14. **Shutdown**: `heartbeat.stop()` -> `memory.close()`

### Sleep Cycle Flow

The sleep cycle is the maintenance routine. It runs via two triggers:

**Trigger 1 -- Startup** (`main.ts`):
- `SleepTrigger.shouldRunOnStartup()` runs if no audit today (or >25h since last)
- Spawns `agentbridge-sleep.js` as detached child process
- Sets `sleepChild` — incoming messages during sleep get auto-reply ("Oh good morning, I am just waking up, give me a minute please.. I answer you soon ☕") and are queued in `pendingMessages`
- On sleep exit, queued messages are re-injected via `telegramPoller.injectUpdate()`

**Trigger 2 -- Heartbeat cron** (`main.ts` heartbeat, `sleep-trigger` task):
- Registered as heartbeat task in `main.ts`, checked every tick (5min)
- `SleepTrigger.shouldRunFromCron(lastMessageTs)` checks conditions + retry state:
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
6. Writes audit trail to `~/.agentbridge/memory/sleep/sleep_YYYYMMDD_HHmmss.md`

**sleeping_prompt.md template sections (target state — Memory Darwinism):**
- §1 Feedback Pass — review today's conversations; for each recalled memory that appeared in context, check user reaction: confirmed → `agentbridge-store --boost`, corrected → `--demote`, ambiguous → skip
- §2 Daily Summary — consolidate working dirs into daily files, weekly/quarterly rollups
- §3 Reminder & Todo Extraction — extract actionable items
- §4 Garbage Collection — 7-step GC protocol:
  - Step 1: Purge expired garbage (>7 days in `garbage.json` → hard DELETE from messages)
  - Step 2: Immediate deletes — dupes (same content/chat within 5min), wrong-chat, STT garbage + paired assistant responses
  - Step 3: Emotion harvest — emotional reactions → update `emotion_score` on nearest extracted_memory, then garbage-mark
  - Step 4: Pure noise — greetings, pings, filler, single chars → garbage-mark (with explicit DO NOT mark list)
  - Step 5: Repeated probes — GROUP BY HAVING cnt≥3, keep first, garbage-mark rest
  - Step 6: Verify extractions — check if conversation facts exist in `extracted_memories`, extract missing via `agentbridge-store --confidence <1-5>`, then garbage-mark verbose originals
  - Step 7: Report — GC summary in sleep audit
- §5 Cron Verification — check scheduled tasks
- §6 Topic Reorg — merge duplicates, update stale, delete empty
- §7 Fitness Review — use recall_count + relevance_score + confidence + last_recalled_at to evaluate extracted memories:
  - High recall + high relevance → promote to core knowledge
  - High recall + negative relevance → candidate for deletion or rewording
  - Zero recall after 60+ days → candidate for archival
  - Low confidence + low recall → first to prune
  - Time-decayed fitness: `fitness ≈ Σ(1 / (1 + days_since_recall))` weighted by relevance_score
- §8 Memory Merge — review top-N most-recalled extracted memories, merge near-duplicates (max 5/cycle, LLM judges similarity, incremental)
- §9 Disk Budget — enforce size limits

**Garbage collection data:**
- `garbage.json` at `~/.agentbridge/garbage.json`: `{"<message_id>": "<ISO timestamp when marked>"}`
- All deletions (Step 1 expired garbage + Step 2 immediate) use `agentbridge-store --delete-ids <ids> --chat-id <id>`, which calls `cascadeDelete()` — removes from DB, JSONL transcript, embeddings, and FTS5 in one operation
- Facts are extracted to `extracted_memories` before verbose originals are garbage-marked (Step 6)
- Transcript/DB drift check on startup warns only when counts diverge (both should stay in sync since cascade delete prunes both)

**chat_backup safety table:**
- Every message recorded via `recordMessage()` is also inserted into `chat_backup`
- Immutable — the LLM is instructed never to delete from it
- Pruned by wired logic only: `pruneBackup()` deletes rows >7 days on startup
- Searchable as Stage 8 fallback in `agentbridge-recall` (LIKE search)

**Prompt Injection Scanning (two-tier):**

Tier 1 — Fast regex gate (`prompt-scanner.ts`), runs synchronously at store time:
- 22 compiled regex patterns + invisible unicode detection (zero-width chars, bidi overrides)
- Covers: role hijack, system prompt leaks, jailbreak patterns (DAN, dev mode), exfiltration (curl/wget secrets), destructive commands, HTML comment injection
- Applied to all `agentbridge-store` calls where trust < 5 (i.e. everything except user's own words)
- On hit: store is blocked, JSON error returned, logged to `~/.agentbridge/logs/prompt_injection.log`
- Same scanner already protects A2A inbound messages (`agent-api-server.ts`)

Tier 2 — Deep LLM scan during sleep cycle (§ in sleeping_prompt.md):
- **STATUS: PASSIVE — not yet wired into sleeping_prompt.md**
- Design: sleep subagent queries all `extracted_memories` stored since last sleep with trust < 5, reads content, applies LLM judgment to detect sophisticated injection (encoded payloads, semantic manipulation, multi-step chains) that regex cannot catch
- On suspicion: log to `prompt_injection.log`, demote memory, flag for aksika review — do NOT auto-delete
- Cost: negligible — typically 5-15 new memories/day, ~3k tokens total

Baseline audit (2026-03-20): All 42 existing extracted memories scanned by both Tier 1 (regex) and Tier 2 (Opus manual review). Result: zero hits. All directive-style content ("DO NOT", "STRICTLY FORBIDDEN") confirmed as legitimate user-set policies (trust=3). No external/web-sourced memories (trust=0) exist yet — injection risk is future-facing, primarily from tweet ingestion pipeline.

### Command Handlers

| Command | Description |
|---------|-------------|
| `/new`, `/reset` | Reset session, clear buffer |
| `/status` | Connection status + uptime + context % |
| `/stop`, `/cancel` | Ctrl+C interrupt |
| `/facts` | Display user core facts |
| `/memory` | Memory stats (messages, extracted, consolidation files, disk, heartbeat, NotebookLM) |
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

- Integer [-5, +5] on `extracted_memories.emotion_score` and `messages.emotion_score`
- Scale: -5=angry, -3=frustrated, -1=slightly negative, 0=neutral, +1=slightly positive, +3=pleased, +5=happy
- Sources:
  - **Telegram reactions**: `emojiToScore()` maps emoji → score, stored on `messages.emotion_score` via `updateEmotionByPlatformId()`. Only authorized users' reactions are processed. Emoji mapping: ❤️/🔥/👏/❤=4, 🤩=4, 👍/😂/💯/⚡=3, 🎉=3, 😊/🙏=2, 🤔/😮/unknown=1, 👎/😢=-3, 😡/🤮=-4, 💩=-5
  - **LLM extraction**: sleep subagent assesses emotion on `extracted_memories`
  - **Agent instant store**: `agentbridge-store` sets emotion on `extracted_memories`
- `messages.platform_message_id` stores the Telegram message_id for reaction lookup (user messages: `message.message_id`, assistant messages: last sent chunk's message_id)
- Search boost (on extracted_memories): `final_score = bm25_score + 0.5 * log1p(abs(emotion_score))`
- Sleep GC Step 3 harvests emotional reactions from `messages.emotion_score` → updates nearest `extracted_memories.emotion_score`

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
- Audit trail: `~/.agentbridge/memory/sleep/sleep_YYYYMMDD_HHmmss.md`
- `package.json` bin: `"agentbridge-sleep": "dist/cli/agentbridge-sleep.js"`

### agentbridge-recall

Agent-initiated memory search across 4 layers + consolidation files + chat_backup (7-stage cascade).

### agentbridge-store

Agent-initiated instant memory storage with emotion scoring.

---

## Test Coverage

648 tests across 62 test files. All passing.

---

## Deployment

`scripts/deploy.sh` builds TypeScript, copies dist + node_modules + package.json to `~/.agentbridge/`, copies `sleeping_prompt.md` and `daily-backup.sh` to `~/.agentbridge/`, and links all bin entries including `agentbridge-sleep`.

`scripts/test-sleep-gc.sh` — integration test for sleep GC. Copies live DB to `/tmp/agentbridge-gc-test/`, snapshots pre/post, diffs. Two-phase: `bash test-sleep-gc.sh` (copy + pre-snapshot), then `bash test-sleep-gc.sh --diff` (post-snapshot + diff).

`scripts/daily-backup.sh` — daily cron job: zips `memory/`, `topics/`, `.kiro/`, `titok/`, `notebooklm/`, `sleeping_prompt.md`, `browsing_prompt.md` to `~/.backup-agentbridge/agentbridge-YYYYMMDD.zip` (7-day retention), then `git add -A && commit && push` to kiroprof-backup.

---

## 🚀 SPINUP — Publication & Research Track

**Working title:** *CIA-Memory: Adapting the NATO Admiralty Code and CIA Triad for Autonomous AI Agent Memory Security*

**Core thesis:** Existing agent memory systems defend against poisoning with trust scoring alone (single axis). We show this is insufficient and propose a four-axis per-memory security model adapted from the NATO Admiralty Code (source reliability + information credibility) and the CIA triad (confidentiality + integrity). To our knowledge, this is the first application of the Admiralty system to AI agent memory.

**The four axes (what nobody else has):**
1. `classification` (NATO: UNCLASSIFIED→SECRET) — who can see this memory
2. `trust` (Admiralty source reliability A-F, simplified to 0-3) — how reliable is the source
3. `credibility` (Admiralty information credibility 1-6) — how accurate is the information itself, independent of source
4. `integrity` (provenance: verbatim→translated→extracted→compacted) — how far from ground truth

**Key insight:** trust ≠ credibility. A trusted source can deliver inaccurate info (bad translation, stale fact). An untrusted source can accidentally provide confirmed facts. The Admiralty Code has enforced this separation since WWII — we adapt it for AI agents.

**Novel contributions:**
1. First application of NATO Admiralty Code to AI agent memory
2. Four orthogonal per-memory fields — not system-level policy, but per-row queryable metadata
3. `integrity` provenance enum tracking multilingual provenance degradation (verbatim→translated→extracted→compacted) — uncharted territory
4. Formal interaction rules (R1-R8): trust never overrides classification, credibility can improve/degrade over time, original language takes precedence
5. Attack taxonomy showing scenarios that succeed against trust-only systems but fail against four-axis model

**Differentiator vs prior art:**
- SuperLocalMemory (arxiv 2603.02240) — Bayesian trust scoring only, no classification, no credibility, no provenance
- Sakura Sky (2025) — 7 memory governance primitives, no per-memory field formalization
- Bell-LaPadula / NATO MLS — classification for documents, never applied to AI agent memories
- OWASP ASI06 — defines the threat, not the defense model
- ISO 25012 — data quality dimensions for databases, not adapted for autonomous agent memory

**Implementation evidence:** AgentBridge — real system, real agent (KP), real users, SQLite+FTS5, Telegram/Discord/A2A channels, NATO classification live, trust+credibility+integrity spec ready.

**Publication path:**
1. arxiv preprint (stake priority claim) + LinkedIn article (visibility)
2. Conference: AAMAS, IEEE S&P Workshop, AAAI Safe AI, NeurIPS ATTRIB
3. Talk: BSides, DEF CON AI Village, AI Engineer Summit

**Paper structure:**
- Abstract → Introduction → Background (Admiralty Code, CIA triad, OWASP ASI06) → Threat Model (4+ attack scenarios) → CIA-Memory Model (formal definitions, four axes, interaction rules) → Implementation (AgentBridge) → Evaluation (attack success rates: baseline vs trust-only vs four-axis) → Related Work → Conclusion

**Status:** Framework defined. Classification (C) implemented. Trust + credibility + integrity (I+A) implementation planned.

---

## Future Ideas

- **Archive DB layer** — if extracted_memories grows to 10K+ and search slows, move zero-recall 60+ day memories to a separate SQLite archive searched as a last-resort fallback after all primary stages.
- **Entity linking** — tag extracted memories with entity mentions (e.g. `@Peter`, `@agentbridge`), maintain per-entity summary pages, enable "tell me about X" queries via entity filter instead of keyword search. Inspired by LCM/OpenClaw's `bank/entities/*.md` pattern.
- **AES encryption for restricted memories** — encrypt `content_en` and `content_original` columns for `classification=3` rows at rest. Derive key from a user-provided passphrase (PBKDF2/scrypt). Decrypt on read only when needed. Prevents `sqlite3` direct access from exposing secrets.
