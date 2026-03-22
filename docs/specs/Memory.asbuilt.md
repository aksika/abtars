# Local Memory — Wanted Position (Post-Refactor Target State)

Created: 2026-03-21
Baseline: Memory.asbuilt.md (current state)
Plan: memory-refactor-plan.md (R1-R6)

---

## Overview

SQLite-backed persistence with FTS5 full-text search, optional local-model vector search, sleep-subagent-driven extraction, agent-initiated instant memory storage with emotion scoring, Memory Darwinism, NATO Admiralty Code security model, daily retrospective with emotional attribution, and immediate emotion propagation.

**Key difference from as-built:** Single storage path (SQLite only, no JSONL runtime writes), single search path (agentbridge-recall only), messages table as hot buffer (flushed after sleep), retrospective-driven self-improvement loop.

**Recall architecture**: Unchanged — agent-driven via `agentbridge-recall` CLI. No bridge-side context injection.

---

## Memory Compartments

| ID | Name | Medium | Written By | Read By | Volatility |
|----|------|--------|------------|---------|------------|
| C0 | LLM Context Window | In-memory | Bridge (raw pass-through) | LLM | Ephemeral |
| C1 | Consolidated Summaries | Markdown files | Sleep subagent | Consolidation search, sleep subagent | Persistent — promoted up tiers |
| C2 | SQLite + FTS5 | `memory.db` | recordMessage(), agentbridge-store | agentbridge-recall | **messages: hot buffer (flushed after sleep). extracted_memories: persistent** |
| ~~C3~~ | ~~JSONL Transcripts~~ | ~~JSONL files~~ | ~~TranscriptWriter~~ | ~~TranscriptParser~~ | **ELIMINATED — nightly SQL export for backup only** |
| C4 | Markdown Knowledge Files | Flat files | Agent, retrospective | Sleep subagent | Persistent |
| C5 | Vector Index | `memory.db` (embeddings) | EmbeddingProvider | VectorIndex | Persistent — optional |
| **C6** | **Retrospectives** | **Markdown files** | **Sleep subagent (step 1)** | **Sleep subagent, agent (via recall)** | **Persistent — NEW** |

### Data Flow (Wanted)

```
User Message
    |
    v
+----------+               +----------+
| C0       |    append     | C2       |  messages table (raw content WITH emojis)
| LLM      |-------------->| SQLite   |  FTS5 trigger strips emojis at index level
| Context  |               |          |
|          |               | extracted_memories (permanent knowledge)
| (agent   |               +----------+
|  decides |                     ^
|  when to |                     |
|  search) |--- recall --------->|  (single path: agentbridge-recall, 5 stages)
|          |                     |
|          |               +----------+
|          |               | C1       |  daily/weekly/quarterly summaries
|          |               | Summaries|
|          |               +----------+
|          |
|          |               +----------+
|          |               | C6       |  retrospectives/retro_YYYYMMDD.md
|          |               | Retros   |  (NEW — daily self-reflection)
|          |               +----------+
+----------+
```

---

## System Layer Architecture (Wanted)

```
+---------------------------------------------------------------------+
|  Layer 7: Overnight Maintenance                                      |
|  agentbridge-sleep, SleepTrigger, SleepStateGatherer,               |
|  sleep-prompt-loader, sleeping_prompt.md template                    |
|  NEW: Retrospective (step 1), Message Flush (step 8)                |
+---------------------------------------------------------------------+
|  Layer 6: REMOVED — ContextAssembler, ContextWindowMonitor deleted   |
+---------------------------------------------------------------------+
|  Layer 5: Agent-Initiated Recall (single path)                       |
|  agentbridge-recall ONLY (5-stage cascade, extracted-first)          |
|  REMOVED: MemorySearchTool, RecallFallbackPipeline, IntentDetector  |
+---------------------------------------------------------------------+
|  Layer 4: Background Extraction & Enrichment                        |
|  HeartbeatSystem, agentbridge-store (Instant Store)                  |
|  MemoryExtractor (class exists, sleep-driven)                        |
|  REMOVED: IngestionPipeline, ReflectionEngine stay but unchanged     |
+---------------------------------------------------------------------+
|  Layer 3: Consolidation (subagent-driven, unchanged)                |
|  working → daily → weekly → quarterly                                |
+---------------------------------------------------------------------+
|  Layer 2: Indexing & Search Primitives                              |
|  MemoryIndex (FTS5), VectorIndex, EmbeddingProvider                 |
|  CHANGED: FTS5 trigger strips emojis, not storage layer             |
+---------------------------------------------------------------------+
|  Layer 1: Storage & Persistence                                     |
|  SQLite ONLY (memory.db), File System                               |
|  REMOVED: TranscriptWriter, TranscriptParser                        |
+---------------------------------------------------------------------+
```

---

## Recall Cascade (Wanted — 5 stages)

| Stage | What | Source | Short-circuit |
|-------|------|--------|---------------|
| 1 | Extracted memories EN FTS5 | `extracted_memories_fts` | If ≥10 results with high Darwinism scores → skip 3-5 |
| 2 | Extracted memories original FTS5 | `extracted_memories_original_fts` | Same short-circuit pool as stage 1 |
| 3 | Raw messages FTS5 (relaxed OR) | `messages_fts` | — |
| 4 | Consolidation file search | daily/weekly/quarterly .md | — |
| 5 | Raw messages LIKE (wide net) | `messages` | — |

Post-processing: dedup by content hash → temporal decay → MMR re-ranking.

**Removed stages:** Strict FTS5 AND (merged into relaxed OR), substring LIKE ×2 (redundant), chat_backup LIKE (table is debug-only).

---

## Sleep Cycle (Wanted — 10 steps)

| Step | What | Behavior | Status vs current |
|------|------|----------|-------------------|
| 1 | **Retrospective** | Reads full messages table. What went well/wrong, emotional attribution, lessons. Writes retro file + updates agent_notes | **NEW** |
| 2 | Purge expired garbage (>7d) | cascadeDelete | Unchanged (was step 1) |
| 3 | Immediate deletes (dupes, wrong-chat, STT) | cascadeDelete | Unchanged (was step 2) |
| 4 | Repeated probes | Garbage-mark → 7d grace | **Moved earlier** (was step 5) |
| 5 | Noise marking | Garbage-mark → 7d grace | Unchanged (was step 4) |
| 6 | Verify-extract-mark | Creates extracted_memories, garbage-marks originals | Unchanged (was step 6) |
| 7 | Emotion harvest (verbal only) | Updates extracted_memories.emotion_score | **Changed scope** — reactions handled at runtime |
| 8 | **Flush old messages** | Delete messages older than 24h | **NEW** |
| 9 | Consolidation | working→daily→weekly→quarterly | **Made explicit** (was implicit in §2) |
| 10 | Report | Audit summary | Unchanged |

---

## Message Lifecycle (Wanted)

```
Message arrives
    │
    ▼
recordMessage() ──► messages table (raw content, emojis preserved)
    │                    │
    │                    ├──► FTS5 trigger (emoji-stripped index)
    │                    └──► chat_backup (DEBUG_MODE only)
    │
    ▼
[During conversation: searchable via agentbridge-recall stages 3,5]
[Agent may instant-store important facts via agentbridge-store → extracted_memories]
    │
    ▼
[Reaction arrives → messages.emotion_score updated → propagated to extracted_memory immediately]
    │
    ▼
[Sleep cycle]
    │
    ├── Step 1: Retrospective reads full messages (raw + emotion_score)
    ├── Steps 2-5: GC (some messages deleted/marked)
    ├── Step 6: Extraction → facts move to extracted_memories
    ├── Step 7: Verbal emotion harvest → extracted_memories.emotion_score
    ├── Step 8: Flush messages older than 24h
    │
    ▼
[After sleep: messages table is compact (today only)]
[extracted_memories has all permanent knowledge]
[retrospectives/ has daily self-reflection]
[daily/weekly/quarterly/ has consolidated summaries]
```

---

## Writes Per Message

| Store | Current | Wanted |
|-------|---------|--------|
| SQLite `messages` | ✅ (emoji-stripped content) | ✅ (raw content, emojis preserved) |
| SQLite `chat_backup` | ✅ (always) | Debug-only |
| JSONL transcript | ✅ (always) | ❌ Eliminated |
| FTS5 `messages_fts` | Via trigger (stripped content) | Via trigger (strips at index level) |
| **Total writes** | **3 stores + trigger** | **1 store + trigger** |

---

## Component Inventory (Wanted)

### Active Components

| Component | File | Change |
|-----------|------|--------|
| MemoryManager | `memory-manager.ts` | Simplified: no JSONL, no drift check, cascadeDelete DB-only |
| MemoryIndex | `memory-index.ts` | FTS5 trigger change: strip emojis at index, not storage |
| agentbridge-recall | `cli/agentbridge-recall.ts` | 5-stage cascade, extracted-first, short-circuit |
| agentbridge-store | `cli/agentbridge-store.ts` | Unchanged |
| agentbridge-sleep | `cli/agentbridge-sleep.ts` | Updated template with retro + flush |
| SleepTrigger | `sleep-trigger.ts` | Unchanged |
| SleepStateGatherer | `sleep-state-gatherer.ts` | Unchanged |
| sleep-prompt-loader | `sleep-prompt-loader.ts` | Unchanged |
| HeartbeatSystem | `heartbeat-system.ts` | Unchanged |
| EmbeddingProvider | `embedding-provider.ts` | Unchanged |
| VectorIndex | `vector-index.ts` | Unchanged |
| PromptScanner | `prompt-scanner.ts` | Unchanged |
| emotion-utils | `emotion-utils.ts` | Unchanged |
| Reaction handler | `main.ts` | **Enhanced:** immediate propagation to extracted_memories |

### Deleted Components

| Component | File | Reason |
|-----------|------|--------|
| TranscriptWriter | `transcript-writer.ts` | R1: JSONL eliminated |
| TranscriptParser | `transcript-parser.ts` | R1: JSONL eliminated |
| MemorySearchTool | `memory-search-tool.ts` | R2: single search path |
| RecallFallbackPipeline | `recall-fallback-pipeline.ts` | R2: single search path |
| IntentDetector | `intent-detector.ts` | R2: single search path |
| ContextAssembler | `context-assembler.ts` | R5: not in active path |
| ContextWindowMonitor | `context-window-monitor.ts` | R5: not in active path |
| CompactionEngine | `compaction-engine.ts` | R5: replaced by sleep subagent |
| DailyCompactionTask | `daily-compaction-task.ts` | R5: replaced by sleep subagent |
| SleepCycleRunner | `sleep-cycle-runner.ts` | R5: replaced by sleep subagent |
| SleepPromptBuilder | `sleep-prompt-builder.ts` | R5: replaced by template loader |

---

## Configuration (Wanted)

Removed env vars:
- ~~`MEMORY_COMPACT_ON_RESET`~~ — CompactionEngine deleted
- ~~`MEMORY_AUTO_COMPACT_THRESHOLD`~~ — CompactionEngine deleted
- ~~`MEMORY_COMPACT_THRESHOLD_PCT`~~ — ContextWindowMonitor deleted
- ~~`MEMORY_CONTEXT_BUDGET_SOUL/RECALLED/WORKING`~~ — ContextAssembler deleted
- ~~`MEMORY_ROLLING_BUFFER_SIZE`~~ — ContextAssembler deleted
- ~~`MEMORY_RECALL_FALLBACK_ENABLED/TIMEOUT_MS`~~ — RecallFallbackPipeline deleted
- ~~`MEMORY_RECALL_CONTEXT_MESSAGES`~~ — IntentDetector deleted
- ~~`MEMORY_RECALL_CUE_PHRASES`~~ — IntentDetector deleted
- ~~`MEMORY_DAY_BOUNDARY_HOURS`~~ — legacy, unused

New env vars:
- `DEBUG_MODE` — enables chat_backup writes
- `MEMORY_RECALL_SHORT_CIRCUIT` — toggle short-circuit in recall cascade

---

## File System Layout (Wanted)

```
~/.agentbridge/memory/
  memory.db                    # SQLite: messages (hot buffer) + extracted_memories (permanent)
  working/
    {YYYY-MM-DD}/              # Intra-day conversation dumps
  daily/
    daily_YYYYMMDD.md          # Daily consolidated summaries
  weekly/
    YYYY-Wxx.md                # Weekly rollups
  quarterly/
    YYYY-Qn.md                 # Quarterly rollups
  retrospectives/              # NEW
    retro_YYYYMMDD.md          # Daily self-reflection with emotional attribution
  core/
    user_profile.md            # Who the user is
    agent_notes.md             # Lessons learned (updated by retrospective)
  audit/
    sleep_YYYYMMDD_HHmmss.md   # Sleep cycle audit logs

  REMOVED:
    transcripts/               # JSONL files — eliminated
```

---

## Test Coverage (Wanted)

Current: 648 tests across 62 files.
Target: ~550 tests across ~50 files (deleted component tests removed, new retro + flush + cascade tests added).

---

## As-Built vs Wanted Position — Comparison

### Storage Efficiency

| Metric | As-Built | Wanted | Verdict |
|--------|----------|--------|---------|
| Writes per message | 3 (SQLite + JSONL + chat_backup) | 1 (SQLite only) | ✅ 3× fewer I/O ops |
| messages table | Grows continuously, slow GC | Hot buffer, flushed after sleep | ✅ Bounded size |
| JSONL files | Permanent, cascade-rewritten on delete | Eliminated | ✅ No file rewrites |
| Emoji data quality | Split (stripped in DB, raw in JSONL) | Unified (raw in DB, stripped at FTS5 index) | ✅ Single source of truth |

### Search Quality

| Metric | As-Built | Wanted | Verdict |
|--------|----------|--------|---------|
| Search paths | 3 (agent uses 1) | 1 | ✅ No dead code, no confusion |
| Recall stages | 8 (noisy raw messages first) | 5 (curated extracted first) | ✅ Better results surface faster |
| Short-circuit | None | Skip fallback when extracted has enough | ✅ Faster for common case |
| LIKE substring stages | 2 (expensive, rarely unique) | 0 | ✅ Less CPU, same recall |

### Self-Improvement

| Metric | As-Built | Wanted | Verdict |
|--------|----------|--------|---------|
| Self-reflection | None | Daily retrospective with emotional attribution | ✅ New capability |
| Lesson persistence | Manual agent_notes updates | Retro → agent_notes automatically | ✅ Closes learning loop |
| Emotion propagation | Sleep-only (12-24h delay) | Immediate for reactions, sleep for verbal | ✅ Faster signal |

### Complexity

| Metric | As-Built | Wanted | Verdict |
|--------|----------|--------|---------|
| Source files (memory) | ~30 | ~19 | ✅ 11 fewer files |
| cascadeDelete | DB + JSONL rewrite + signature matching | DB only | ✅ Simpler, no fragile matching |
| Drift check | Needed (two stores can desync) | Eliminated | ✅ Can't desync with one store |
| Sleep GC steps | 9 (no retro, suboptimal order) | 10 (retro + flush, optimized order) | ✅ More capable, better ordered |
| Config env vars | 28 | 19 (9 removed, 2 added) | ✅ Less to configure |

### Risk

| Concern | Assessment |
|---------|------------|
| Recall quality regression | Low — Phase A validates with real queries before removing anything |
| Data loss from message flush | Low — extraction captures facts, retro captures context, consolidation captures summaries |
| Retro token cost | ~2-3K tokens/day (one conversation read + 5 questions). Negligible vs existing sleep cost |
| Emoji in FTS5 | None — stripping moves to trigger, search quality unchanged |

### What doesn't improve

- Consolidation pipeline — unchanged (already working)
- Security model — unchanged (already designed for paper)
- Extraction latency — unchanged (sleep + instant store is sufficient)
- GC location — unchanged (all in sleep, correct decision)

## Doctor (`scripts/doctor.sh`)

Two-stage health check inspired by OpenClaw's `openclaw doctor` / `openclaw doctor --repair` pattern.

### Usage

```bash
doctor.sh          # diagnose only — prints warnings, changes nothing (runs on startup)
doctor.sh --fix    # diagnose + apply repairs
```

### Diagnose (default, safe for startup)

| # | Check | Warns when |
|---|-------|------------|
| 1 | Directory permissions | Sensitive dirs (`titok/`, `cookies/`, `memory/`) not 700 |
| 2 | Stale locks | `.lock` files older than 1 hour |
| 3 | Stale browse artifacts | `browse_*` files in `logs/` older than 3 days |
| 4 | Cookie validity | `x-cookies.json` missing or invalid JSON |
| 5 | Required dirs | Any of `twitterX/`, `skills/`, `logs/`, `memory/sleep/`, `memory/retrospectives/` missing |
| 6 | Follows file | `base.follows.json` missing |
| 7 | Recent backup | No `agentbridge-*.zip` in `~/.backup-agentbridge/` within 2 days |
| 8 | DB integrity | `PRAGMA integrity_check` fails |
| 9 | DB size | `memory.db` exceeds 400MB (80% of 500MB budget) |
| 10 | Sleep recency | No `sleep_*.md` audit in last 3 days |

### Fix (`--fix`, manual only)

All diagnose checks above, plus applies repairs:
- chmod 700 on sensitive dirs
- Remove stale locks and browse artifacts
- Create missing dirs
- FTS5 rebuild (`messages_fts` + `extracted_memories_fts`)
- WAL checkpoint (truncate)
- Git push dry-run (5s timeout) — verifies backup push will work

### Integration

`agentbridge.sh` runs `doctor.sh` (diagnose only) before starting the bridge. No `-e` flag — individual check failures don't block startup.

### Conclusion

The refactor enhances the system on every axis that matters: fewer writes, bounded storage, better search ordering, self-reflection capability, simpler deletion logic, less dead code. The only addition in complexity is the retrospective — which is a net-new capability, not overhead. No functionality is lost.
