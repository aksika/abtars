# Local Memory — As-Built Documentation

## Overview

The local memory layer provides SQLite-backed persistence, JSONL transcript files, FTS5 full-text search, optional local-model vector search, hierarchical memory consolidation (daily → weekly → quarterly), dynamic context assembly with token budgets, external document ingestion, LLM-generated reflections, embedding model hot-swap, selective forgetting, heartbeat-driven background extraction with English-normalized dual-column storage, agent-initiated memory search with temporal decay and MMR diversity, context window monitoring, per-session context injection, agent-initiated instant memory storage with emotion scoring, emotion-boosted search ranking, and an automated overnight sleep maintenance cycle.

### Phase Summary

| Phase | Scope | Status |
|-------|-------|--------|
| Phase 1 — Foundation | LLM compaction, context assembly, rolling summary | ✅ Complete |
| Phase 2 — Commands | `/ingest`, `/reflect`, `/reembed`, `/forget` | ✅ Complete |
| Search Enhancements | Heartbeat extraction, English-normalized storage, agent recall, temporal decay, MMR | ✅ Complete |
| Instant Memory Store | Agent-initiated storage, emotion scoring, emotion-boosted ranking | ✅ Complete |
| Sleep CLI | Automated overnight maintenance: state gathering, subagent-driven cleanup, audit trail | ✅ Complete |
| Phase 3 — Intelligence | Proactive recall, importance scoring, contradiction detection | 📋 Designed |

---

## File System Layout

All paths relative to `~/.agentbridge/memory/` (configurable via `MEMORY_DIR`).

```
~/.agentbridge/memory/
├── memory.db                    # SQLite database (messages, compactions, embeddings, sessions, extracted_memories, etc.)
├── transcripts/
│   └── {chatId}/
│       └── {sessionId}.jsonl    # Raw JSONL transcript per session
├── working/
│   └── {YYYY-MM-DD}/
│       └── transcript_{chatId}.md  # Intra-day working memory (pre-compaction)
├── daily/
│   └── daily_YYYYMMDD.md       # Daily consolidated summaries (no hyphens in date)
├── weekly/
│   └── YYYY-Wxx.md             # Weekly rollup summaries (ISO week)
├── quarterly/
│   └── YYYY-Qn.md              # Quarterly rollup summaries
├── scratchpads/
│   └── {chatId}/scratchpad.md  # Per-chat scratchpad
├── core/
│   └── {chatId}/user_core_facts.md  # Per-chat permanent facts
├── audit/
│   └── sleep_YYYYMMDD_HHmmss.md    # Sleep cycle audit trail logs
└── (legacy: monthly/, yearly/ — preserved, not actively written)
```

---

## Architecture

```
src/
├── types/
│   ├── memory.ts              # All memory types (MessageRecord, MemoryTier, CompactedMemory, etc.)
│   └── index.ts               # Re-exports
├── components/
│   ├── memory-config.ts       # MemoryConfig type + loadMemoryConfig()
│   ├── memory-db.ts           # SQLite schema creation + migrations
│   ├── memory-manager.ts      # Top-level coordinator
│   ├── memory-index.ts        # FTS5 search (messages + extracted memories) + emotion boost
│   ├── memory-search-tool.ts  # Agent-initiated recall with decay + MMR
│   ├── memory-extractor.ts    # LLM-based extraction with emotion scoring
│   ├── emotion-utils.ts       # clampEmotionScore() utility
│   ├── heartbeat-system.ts    # Periodic background task runner
│   ├── context-window-monitor.ts # Threshold-based async compression
│   ├── transcript-writer.ts   # JSONL append
│   ├── transcript-parser.ts   # JSONL read + parseTail()
│   ├── compaction-engine.ts   # Daily compaction + tier consolidation
│   ├── sleep-cycle-runner.ts  # Hierarchical rollups (daily→weekly, weekly→quarterly)
│   ├── sleep-trigger.ts       # Sleep trigger logic (startup + cron)
│   ├── sleep-state-gatherer.ts # System state snapshot for sleep prompt
│   ├── sleep-prompt-builder.ts # Builds comprehensive maintenance prompt
│   ├── context-assembler.ts   # 5-tier context with token budgets + English rolling summary
│   ├── embedding-provider.ts  # Local ONNX embeddings + model hot-swap + reembed
│   ├── vector-index.ts        # Model-version-aware cosine similarity
│   ├── ingestion-pipeline.ts  # YouTube/PDF/text/markdown ingestion
│   ├── reflection-engine.ts   # LLM-generated meta-summaries
│   ├── recall-fallback-pipeline.ts # Multi-stage search cascade
│   └── intent-detector.ts     # Recall intent + temporal range detection
├── cli/
│   ├── agentbridge-sleep.ts   # Sleep CLI entry point (overnight maintenance orchestrator)
│   ├── agentbridge-recall.ts  # Agent-initiated memory search (L1-L4 + compactions)
│   └── agentbridge-store.ts   # Agent-initiated instant memory storage
├── skills/
│   ├── memory-search/SKILL.md
│   └── instant-store/SKILL.md
└── main.ts                    # Transport wiring, command handlers, sleep trigger integration
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
| SQLite schema | `components/memory-db.ts` | 8 tables + 3 FTS5 virtual tables + triggers + migrations |
| MemoryIndex | `components/memory-index.ts` | BM25 search, prune, removeSession, searchExtracted, searchOriginal, emotion boost |
| EmbeddingProvider | `components/embedding-provider.ts` | ONNX embeddings, model versioning, reembed |
| VectorIndex | `components/vector-index.ts` | Model-version-aware cosine similarity |
| CompactionEngine | `components/compaction-engine.ts` | Daily→weekly→quarterly consolidation, English summaries |
| SleepCycleRunner | `components/sleep-cycle-runner.ts` | Hierarchical rollups (7 daily→weekly, 4 weekly→quarterly) |
| ContextAssembler | `components/context-assembler.ts` | 5-tier assembly + English rolling summary + session injection |
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
| RecallFallbackPipeline | `components/recall-fallback-pipeline.ts` | Multi-stage cascade (primary→context→relaxed→substring→vector→temporal) |
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
| agentbridge-sleep CLI | `cli/agentbridge-sleep.ts` | Orchestrator: gather state → build prompt → invoke subagent → audit |
| SleepTrigger | `components/sleep-trigger.ts` | Startup catch-up + cron-based trigger logic |
| SleepStateGatherer | `components/sleep-state-gatherer.ts` | Scans working dirs, DB stats, FTS5 health, disk usage, topic files |
| SleepPromptBuilder | `components/sleep-prompt-builder.ts` | Builds comprehensive maintenance prompt for subagent |
| SleepCycleRunner | `components/sleep-cycle-runner.ts` | Daily→weekly (7 files) and weekly→quarterly (4 files) rollups |

### Phase 3 — Intelligence (Designed, Not Implemented)

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
| `MEMORY_CONTEXT_BUDGET_SCRATCHPAD` | `300` | Token budget: scratchpad tier |
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
| `MEMORY_HEARTBEAT_INTERVAL_MS` | `60000` | Heartbeat tick interval |
| `MEMORY_SEARCH_TIMEOUT_MS` | `1000` | Search timeout |
| `MEMORY_DECAY_HALFLIFE_DAYS` | `30` | Temporal decay half-life |
| `MEMORY_MMR_LAMBDA` | `0.7` | MMR diversity parameter |
| `MEMORY_DAY_BOUNDARY_HOURS` | `4` | Inactivity gap for day boundary |
| `MEMORY_SLEEP_INTERVAL_HOURS` | `24` | Hours between sleep runs |
| `MEMORY_SLEEP_MORNING_HOUR` | `9` | Earliest hour for morning catch-up |
| `MEMORY_SLEEP_INACTIVITY_MINUTES` | `30` | User inactivity before cron sleep |


---

## Data Flow

### Message Processing Pipeline

1. **Startup**: `main.ts` → `loadMemoryConfig()` → `MemoryManager.initialize()` → opens SQLite, creates schema, optionally loads embedding model, initializes IngestionPipeline + ReflectionEngine
2. **LLM Callback**: `memory.setLlmCall(...)` wires transport for compaction, context assembly, reflections, extraction
3. **Heartbeat Start**: `memory.startHeartbeat()` registers memory-extraction + consolidation + sleep-trigger cron tasks
4. **Sleep Startup Check**: `SleepTrigger.shouldRunOnStartup()` → spawns `agentbridge-sleep.js` detached if needed
5. **Message In**: `memory.recordMessage()` → JSONL append → FTS5 index → optional vector index → prune → disk budget check every 100 writes
6. **Background Extraction** (heartbeat): MemoryExtractor queries unprocessed transcripts → LLM extracts structured memories with emotion scores → dual-column `content_en` + `content_original` → FTS5 auto-index → watermark advanced
7. **Instant Storage**: Agent invokes `agentbridge-store` CLI → validates → clamps emotion → inserts `extracted_memories` → advances watermark
8. **Context Assembly**: 5-tier: Soul → Scratchpad → Recalled → Working (English rolling summary + last N) → New Input. ContextWindowMonitor checks threshold after assembly.
9. **Agent Search**: `agentbridge-recall` → FTS5 English + compactions + optional original-language → merge + deduplicate → temporal decay → MMR re-ranking
10. **Auto-Compaction**: When context window exceeds `MEMORY_COMPACT_THRESHOLD_PCT` (default 85%), writes safety-net transcript to working dir, sends `/compact` to Kiro CLI, updates watermark
11. **Consolidation** (heartbeat): 7 daily → 1 weekly, 4 weekly → 1 quarterly. English summaries.
12. **Sleep Cycle** (cron or startup): SleepTrigger fires → `agentbridge-sleep` gathers state → builds prompt → invokes Opus subagent → subagent performs maintenance → audit trail written
13. **Shutdown**: `memory.stopHeartbeat()` → `memory.close()`

### Sleep Cycle Flow

The sleep cycle is the overnight maintenance routine. It runs via two triggers:

**Trigger 1 — Startup catch-up** (`main.ts`):
- On boot, `SleepTrigger.shouldRunOnStartup()` checks:
  - No previous audit file exists, OR
  - Most recent audit older than `MEMORY_SLEEP_INTERVAL_HOURS`, OR
  - New calendar day AND hour >= `MEMORY_SLEEP_MORNING_HOUR` AND yesterday's working dir exists
- If true, spawns `agentbridge-sleep.js` as detached child process

**Trigger 2 — Internal cron** (`memory-manager.ts` heartbeat):
- Registered as heartbeat task, checked every tick (default 60s)
- `SleepTrigger.shouldRunFromCron(lastMessageTs)` checks:
  - `MEMORY_SLEEP_INTERVAL_HOURS` elapsed since last sleep, AND
  - User inactive for `MEMORY_SLEEP_INACTIVITY_MINUTES`
  - Transport not busy (no active user prompts)
- If true, spawns `agentbridge-sleep.js` as detached child process

**Sleep CLI Execution** (`agentbridge-sleep.ts`):
1. Initialize MemoryManager (opens DB)
2. `SleepStateGatherer.gather()` → scans working dirs, queries DB stats, checks FTS5 integrity, calculates disk usage, lists topic files
3. `SleepPromptBuilder.build(snapshot)` → constructs comprehensive maintenance prompt with:
   - System state tables (working dirs, DB stats, FTS5 health, disk usage, topic files)
   - Daily consolidation instructions (past-day working dirs → `daily_YYYYMMDD.md`)
   - Database cleanup instructions (FTS5 repair, orphan deletion, message pruning, VACUUM/ANALYZE)
   - Disk budget enforcement instructions
   - Topic reorganization instructions (merge duplicates, update stale, delete empty)
4. `--dry-run`: prints prompt to stdout and exits
5. Normal mode: invokes subagent via ACP transport (model priority: Opus 4 → Sonnet 4 → Sonnet 3.5)
6. Parses outcome counts from subagent response (regex-based)
7. Writes audit trail to `~/.agentbridge/memory/audit/sleep_YYYYMMDD_HHmmss.md`

**Consolidation Thresholds** (`SleepCycleRunner`):
- 7 daily files in same ISO week → weekly rollup (`YYYY-Wxx.md`)
- 4 weekly files in same quarter → quarterly rollup (`YYYY-Qn.md`)
- Source files deleted after successful consolidation

### Command Handlers

| Command | Description |
|---------|-------------|
| `/new`, `/reset` | Reset session, clear buffer |
| `/status` | Connection status + uptime + context % |
| `/stop`, `/cancel` | Ctrl+C interrupt |
| `/compact` | Manual LLM compaction |
| `/facts` | Display user core facts |
| `/scratchpad` | Display scratchpad |
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
1. Writes raw transcript to `working/{YYYY-MM-DD}/transcript_{chatId}.md` as safety net
2. Sends `/compact` command to Kiro CLI agent for LLM summarization
3. Updates compaction watermark in DB

### Emotion Scoring

- Integer [-5, +5] on `extracted_memories.emotion_score`
- Scale: -5=angry, -3=frustrated, -1=slightly negative, 0=neutral, +1=slightly positive, +3=pleased, +5=happy
- Assessed by agent (instant store) and LLM (heartbeat extraction)
- Search boost: `final_score = bm25_score + 0.5 * log1p(abs(emotion_score))`

### LLM Callback Wiring

Single callback registered in `main.ts`: `memory.setLlmCall((prompt, content) => transport.sendPrompt("system:memory", ...))`. Flows to CompactionEngine, SleepCycleRunner, ContextAssembler, ReflectionEngine, MemoryExtractor. All consumers handle null gracefully.

### Consolidation Tiers

| Source | Target | Threshold | File Naming |
|--------|--------|-----------|-------------|
| working dirs | daily | Past-day dirs (sleep subagent) | `daily_YYYYMMDD.md` |
| daily | weekly | 7 daily files in same ISO week | `YYYY-Wxx.md` |
| weekly | quarterly | 4 weekly files in same quarter | `YYYY-Qn.md` |
| (legacy monthly/yearly preserved but not actively written) | | | |

---

## CLI Tools

### agentbridge-sleep

Overnight maintenance orchestrator. Thin CLI that gathers state, builds prompt, invokes subagent.

```
agentbridge sleep [--dry-run] [--verbose]
```

- `--dry-run`: Gather state + build prompt, print to stdout, skip subagent
- `--verbose`: Detailed logging at each phase
- Exit 0 on success, 1 on fatal error
- Always uses ACP transport (never tmux)
- Model priority: `claude-opus-4-0-20250514` → `claude-sonnet-4-20250514` → `claude-sonnet-3-5-20241022`
- Audit trail: `~/.agentbridge/memory/audit/sleep_YYYYMMDD_HHmmss.md`
- `package.json` bin: `"agentbridge-sleep": "dist/cli/agentbridge-sleep.js"`

### agentbridge-recall

Agent-initiated memory search across 4 layers + compactions.

### agentbridge-store

Agent-initiated instant memory storage with emotion scoring.

---

## Test Coverage

466 tests across 40 test files. All passing.

---

## Deployment

`scripts/deploy.sh` builds TypeScript, copies dist + node_modules + package.json to `~/.agentbridge/`, and links all bin entries including `agentbridge-sleep`.
