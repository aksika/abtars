# Local Memory — As-Built (Post-Refactor)

Updated: 2026-03-22
Refactor: R1-R6 complete (see memory-refactor-plan.md)

---

## Overview

SQLite-backed persistence with FTS5 full-text search, optional local-model vector search, sleep-subagent-driven extraction, agent-initiated instant memory storage with emotion scoring, Memory Darwinism, NATO Admiralty Code security model, daily retrospective with emotional attribution, and immediate emotion propagation.

**Key difference from as-built:** Single storage path (SQLite only, no JSONL runtime writes), single search path (agentbridge-recall only), messages table as hot buffer (flushed after sleep), retrospective-driven self-improvement loop, heartbeat liveness tracking.

**Recall architecture**: Agent-driven via `agentbridge-recall` CLI. Session-start context injection via `buildSessionStartContext` (see below).

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

### Data Flow

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
|  search) |--- recall --------->|  (single path: agentbridge-recall, 7 stages)
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

## System Layer Architecture

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
|  agentbridge-recall ONLY (7-stage cascade, extracted-first)          |
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

## Recall Cascade ( 7 stages)

| Stage | What | Source | Short-circuit |
|-------|------|--------|---------------|
| 1 | Extracted memories EN FTS5 | `extracted_memories_fts` | If ≥10 results with high Darwinism scores → skip 3-7 |
| 2 | Extracted memories original FTS5 | `extracted_memories_original_fts` | Same short-circuit pool as stage 1 |
| 3 | Raw messages FTS5 (relaxed OR) | `messages_fts` | — |
| 4 | Consolidation file search | daily/weekly/quarterly .md | — |
| 5 | Raw messages LIKE (wide net) | `messages` | — |
| 6-7 | Keyword-free fallback (exclusive) | `messages` or `daily/*.md` | Only if stages 1-5 returned zero results |

Stages 6-7 are keyword-free and mutually exclusive. They compare timestamps to decide which source is fresher:
- Recent messages (`timestamp < context-window-start`) vs latest daily summary
- Whichever is fresher wins; the other is not injected (avoids context bloat)
- Context window boundary tracked in `~/.agentbridge/memory/context-window-start.json` (keyed by chatId)
- Updated on: bridge startup, `/new`, auto-compaction. Reset to NOW on sleep completion.

Post-processing: dedup by content hash → temporal decay → MMR re-ranking.

---

## Recall Sovereignty (REQ-1 through REQ-5)

Memory recall is agent-driven only. The bridge never auto-injects recalled memories into prompts. The agent decides when to call `agentbridge-recall` based on conversation context.

### Session-Start Context Injection (REQ-3, REQ-4)

On the first message after startup, `/new`, `/reset`, or `/restart`, the bridge prepends a short context recap to the prompt. This gives the agent enough to continue naturally without blowing up the context window.

**Implementation:** `buildSessionStartContext()` in `src/components/session-context.ts`, called via shared `preparePrompt()` helper in `main.ts` (used by both Telegram and Discord handlers).

**Tracking:** `pendingSessionStart: Set<string>` — added on session reset events, consumed on first message.

**Two paths, same budget (~400 tokens / 2000 chars):**

| Condition | Source | What's injected |
|-----------|--------|-----------------|
| Messages newer than latest daily | `messages` table (last 10, since daily timestamp) | `[HH:MM] role: content` lines |
| No newer messages (overnight) | Latest `daily_*.md` file | Full daily summary (truncated at 2000 chars if needed) |
| No daily exists at all | `messages` table (last 10) | `[HH:MM] role: content` lines |
| No daily, no messages | — | Nothing injected (null) |

**Output format (REQ-4 temporal markers):**
```
[LAST SESSION SUMMARY — ended 2026-03-22T08:48:41.000Z]
<body: daily summary or recent messages>
[SESSION START — 2026-03-22T20:50:00.000Z]
```

The time gap between "ended" and "SESSION START" tells the agent how stale the context is.

**Deeper recall:** If the user asks for more detail ("What did we talk about yesterday?"), the agent can pull the full daily summary via `agentbridge-recall` stage 4 (consolidation file search) or stages 6-7 (keyword-free fallback).

**Removed (2026-03-22):**
- `writeStartupGreeting()` from `agentbridge-sleep.ts` — sleep no longer generates greetings
- `consumeStartupGreeting()` from `main.ts` — no more file-based greeting
- `[SYSTEM]` inject hack via `telegramPoller.injectUpdate()` — replaced by proper prompt prepend

**Bug fix (2026-03-22):** Stage 3 was broken since inception — `sanitizeFtsQuery` double-processed the OR query, turning `OR` operators into literal `"OR"*` search terms. Fixed by passing `mode: "or"` to `index.search()`.

**Removed stages:** Strict FTS5 AND (merged into relaxed OR), substring LIKE ×2 (redundant), chat_backup LIKE (table is debug-only).

---

## Sleep Cycle ( 10 steps)

### Trigger (`SleepTrigger` in `sleep-trigger.ts`)

Registered as `sleep-trigger` task in the unified HeartbeatSystem (5-min interval).

**Startup:** runs if no audit file exists for today AND last audit is >25h old (or ≥8am).

**Cron (heartbeat tick):** runs if ≥8am, 10min idle (no messages), and no audit today.

**Retry on failure:** up to 3 attempts per 24h cycle:
- Attempt 1: normal trigger (startup or cron)
- Attempt 2: immediate retry on next heartbeat tick after failure
- Attempt 3: only after 1h cooldown from last failure

On success or 3 failures: stops until next day. Writes a `.lock` file before spawning to prevent duplicate spawns across restarts.

### Steps

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

## Message Lifecycle

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
[During conversation: searchable via agentbridge-recall stages 3-5]
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

## Component Inventory

### Active Components

| Component | File | Change |
|-----------|------|--------|
| MemoryManager | `memory-manager.ts` | Simplified: no JSONL, no drift check, cascadeDelete DB-only |
| MemoryIndex | `memory-index.ts` | FTS5 trigger change: strip emojis at index, not storage |
| agentbridge-recall | `cli/agentbridge-recall.ts` | 7-stage cascade, extracted-first, keyword-free fallback, short-circuit |
| agentbridge-store | `cli/agentbridge-store.ts` | Unchanged |
| agentbridge-sleep | `cli/agentbridge-sleep.ts` | Updated template with retro + flush. Removed `writeStartupGreeting` |
| SessionContext | `components/session-context.ts` | **NEW:** `buildSessionStartContext()` — session-start context injection |
| SleepTrigger | `sleep-trigger.ts` | Unchanged |
| SleepStateGatherer | `sleep-state-gatherer.ts` | Unchanged |
| sleep-prompt-loader | `sleep-prompt-loader.ts` | Unchanged |
| HeartbeatSystem | `heartbeat-system.ts` | Writes `.heartbeat` timestamp on each tick |
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

## Configuration

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

## File System Layout

```
~/.agentbridge/memory/
  memory.db                    # SQLite: messages (hot buffer) + extracted_memories (permanent)
  context-window-start.json    # Per-chat session boundary timestamps (for recall fallback)
  .heartbeat                   # Epoch ms — written by HeartbeatSystem on each tick
  cron.json                    # Internal cron entries (one-shot + recurring)
  pending_reminders.json       # File-based IPC: cron → reminder injector
  garbage.json                 # GC tracking: message_id → marked timestamp
  todo.md                      # Agent-managed todo list
  working/
    {YYYY-MM-DD}/              # Intra-day conversation dumps
  daily/
    daily_YYYYMMDD.md          # Daily consolidated summaries
  weekly/
    YYYY-Wxx.md                # Weekly rollups
  quarterly/
    YYYY-Qn.md                 # Quarterly rollups
  retrospectives/
    retro_YYYYMMDD.md          # Daily self-reflection with emotional attribution
  core/
    user_profile.md            # Who the user is
    agent_notes.md             # Lessons learned (updated by retrospective)
  sleep/
    sleep_YYYYMMDD_HHmmss.md   # Sleep cycle audit logs
    sleep_YYYYMMDD.lock        # Sleep spawn lock (prevents duplicates)
```

---

## Test Coverage

621 tests across 60 files (as of 2026-03-22, post recall-sovereignty session context).

---

### Conclusion

The refactor eliminated JSONL dual-writes, simplified search to a single 7-stage extracted-first cascade (with keyword-free fallback), added daily retrospective capability, restructured the sleep cycle, removed dead code (-3326 lines), added immediate emotion propagation, and implemented recall sovereignty with session-start context injection. SQLite is the single source of truth.
