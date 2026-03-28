# Local Memory — As-Built

> **Update rules:** This document reflects the CURRENT state of the system. When updating:
> - Never add historical notes ("was X", "changed from Y", "removed Z")
> - Never use strikethrough (~~) for deleted components — just remove the row
> - Never annotate with NEW/REMOVED/Unchanged — every line describes what exists NOW
> - If a component is deleted, delete its documentation entirely
> - Refactor history belongs in git commits and backlog, not here

---

## Overview

SQLite-backed persistence with FTS5 full-text search, ollama vector embeddings (Se sidecar), sleep-subagent-driven extraction, agent-initiated instant memory storage with emotion scoring, Memory Darwinism, NATO Admiralty Code security model, daily retrospective with emotional attribution, and immediate emotion propagation.
**Recall architecture**: Agent-driven via `agentbridge-recall` CLI. Session-start context injection via `buildSessionStartContext` (see below).

---

## Memory Compartments

| ID | Name | Medium | Written By | Read By | Volatility |
|----|------|--------|------------|---------|------------|
| C0 | LLM Context Window | In-memory | Bridge (raw pass-through) | LLM | Ephemeral |
| C1 | Consolidated Summaries | Markdown files | Sleep subagent | Consolidation search, sleep subagent | Persistent — promoted up tiers |
| C2 | SQLite + FTS5 | `memory.db` | recordMessage(), agentbridge-store | agentbridge-recall | messages: hot buffer (flushed after sleep). extracted_memories: persistent |
| C4 | Markdown Knowledge Files | Flat files | Agent, retrospective | Sleep subagent | Persistent |
| C5 | Embeddings | `memory.db` (`extracted_memories.embedding` BLOB) | ollama nomic-embed-text (on insert + batch) | recall-engine Se sidecar | Persistent — gated by `EMBEDDING_ENABLED` |
| C6 | Retrospectives | Markdown files | Sleep subagent | Sleep subagent, agent (via recall) | Persistent |

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
|          |               | Retros   |  (daily self-reflection)
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
+---------------------------------------------------------------------+
+---------------------------------------------------------------------+
|  Layer 5: Agent-Initiated Recall (single path)                       |
|  agentbridge-recall ONLY (7-stage cascade, extracted-first)          |
+---------------------------------------------------------------------+
|  Layer 4: Background Extraction & Enrichment                        |
|  HeartbeatSystem, agentbridge-store (Instant Store)                  |
|  MemoryExtractor (class exists, sleep-driven)                        |
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
+---------------------------------------------------------------------+
```

---

## Recall Pipeline (`recall-engine.ts`, S1-S7 + Se)

Source: `src/components/recall-engine.ts`
CLI wrapper: `src/cli/agentbridge-recall.ts`
Dashboard: `src/components/memory-search-controller.ts` (delegates to recall-engine)
Called by: KP via `execute_bash: agentbridge-recall --translated "kw1,kw2" --chat-id <id> [--original <kw>] [--stages S1,S3]`

```
Se: async embedding sidecar ─────────────┐  (fires at S1 start, ollama nomic-embed-text)
                                           │
S1: Extracted memories — English FTS5      │  content_en, Darwinism-boosted scoring
S2: Extracted memories — Original FTS5     │  content_original, only if --original provided
S3: Extracted memories — LIKE fallback     │  content_en + content_original, score ×0.95
  → merge Se results here ◄───────────────┘
  → Short-circuit: if S1+S2+S3+Se ≥ 10 results → skip S4-S7

S4: Raw messages — FTS5 (relaxed OR mode)
S5: Raw messages — LIKE (wide net fallback, only if results < limit)
S6: Consolidation file search (daily/weekly/quarterly .md on disk)
S7: Keyword-free fallback (exclusive, only if zero results)
    Compares timestamps: recent messages vs latest daily summary, fresher wins.
```

Post-processing: dedup by content hash → temporal decay → MMR re-ranking (λ=0.7).

Se sidecar: gated by `EMBEDDING_ENABLED=true`. When disabled, Se is absent. Fires async at S1 start (~20-50ms via ollama), result consumed after S3. Zero added latency.

Return type includes per-stage hits, timing (ms), and short-circuit info. Dashboard uses this for investigation.

**Hit-rate logging:** Per-stage hit counts emitted to stderr. Format: `[recall] query="..." S1=N S2=N S3=N Se=N S4=N S5=N S6=N short_circuit=S3|none total=N`.

### Embedding Lifecycle (C5)

Embeddings convert text into a 768-dimensional vector where similar meanings are close together in vector space. "puppy" and "kiskutya" have similar vectors because they mean the same thing, even though the words are completely different. This enables semantic search — finding memories by meaning, not just keyword matching.

Model: `nomic-embed-text` via ollama (768 dimensions, CPU-only, ~20-50ms/query, fully local). Gated by `EMBEDDING_ENABLED=true`.

| Event | What happens |
|-------|-------------|
| `agentbridge-store` (instant) | `embedNewMemory()` — fire-and-forget after INSERT |
| Dreamy extraction (sleep) | `embedBatch()` — embeds all new memories after INSERT |
| `agentbridge-embed` CLI | One-time batch embed of all memories with NULL embedding |
| Recall (Se sidecar) | `embedText(query)` fired async at S1, cosine similarity after S3 |
| `doctor.sh --fix` | Detects and batch-embeds memories with NULL embedding |

Storage: `embedding` BLOB column on `extracted_memories` (768 × 4 bytes = 3KB per memory). Threshold: 0.5 cosine similarity (configurable via `EMBEDDING_SIMILARITY_THRESHOLD`).

---

## Session Context Window

What the agent sees when a new session starts (ACP transport, `professor` agent):

### Layer 1: Agent system prompt
- `professor.json` → `"You are Kiro Professor. Follow your SOUL.md identity."`
- All built-in kiro-cli tools available (`"tools": ["*"]`, `"allowedTools": ["@builtin"]`)

### Layer 2: Steering resources (`~/.agentbridge/.kiro/steering/**/*.md`)

| Type | Files | Loading |
|------|-------|---------|
| `alwaysApply: true` | `TOOLS.md` (825 bytes) | Always in system prompt |
| No skill frontmatter | `SOUL.md` (5.4KB), `session-start.md` (577 bytes) | Loaded as resources — always available |
| Skill files (`name:` frontmatter) | 15 skills (~21KB total) | On-demand — agent sees skill list, invokes when needed |

### Layer 3: Session-start context (first message only)

Prepended to the user's first message by `buildSessionStartContext()`:

```
[LAST SESSION SUMMARY — ended <timestamp>]
<last 8 messages OR daily summary>
[SESSION START — <timestamp>]

<user's actual message>
```

~2500 chars max for recent messages path. Full daily (~3000 chars) for overnight path.

### Layer 4: User message

The actual message from Telegram/Discord, prefixed with platform tag:
- Telegram: `[Telegram] <message>`
- Discord: `[Discord] [username] in #channel: <message>` (channel = DM for direct messages)

---

## Multi-Platform Architecture

The agent operates across Telegram and Discord simultaneously, modeled on how a human handles multiple chat apps:

### Isolation: Separate context windows (C0)

Each platform+channel gets its own ACP session (keyed `telegram:<chatId>` or `discord:<channelId>`). Context windows never mix — a reply on Discord cannot be confused with a Telegram conversation in real-time.

### Shared: One memory (C2, C1, C4, C6)

All platforms write to the same SQLite database and the same consolidation files. The agent has one brain — facts learned on Telegram are recallable from Discord and vice versa. Messages are tagged with `[Telegram]`/`[Discord]` prefixes in the `content` column for attribution.

### Session-start context (Layer 3)

`buildSessionStartContext()` reads ALL recent messages regardless of platform (no `chatId` filter on the `messages` query). This is intentional — when starting a new Discord session, the agent should know what happened on Telegram earlier that day, just as a human would.

### Sleep consolidation (Dreamy)

Daily summaries (`daily_YYYY-MM-DD.md`) cover all platforms in one file. The sleep prompt instructs the subagent to note platform transitions when conversations carry different threads (e.g. "Morning on Telegram: …, Afternoon on Discord: …"). Extracted memories and retrospectives are platform-agnostic — one brain.

### Core files

`~/.agentbridge/memory/core/user_profile.md` and `agent_notes.md` are injected into every session on every platform. Doctor warns if either exceeds 15 non-empty lines (limit: 10).

---

## Recall Sovereignty (REQ-1 through REQ-5)

Memory recall is agent-driven only. The bridge never auto-injects recalled memories into prompts. The agent decides when to call `agentbridge-recall` based on conversation context.

### Session-Start Context Injection (REQ-3, REQ-4)

On the first message after startup, `/new`, `/reset`, or `/restart`, the bridge prepends a short context recap to the prompt. This gives the agent enough to continue naturally without blowing up the context window.

**Implementation:** `buildSessionStartContext()` in `src/components/session-context.ts`, called via shared `preparePrompt()` helper in `main.ts` (used by both Telegram and Discord handlers).

**Tracking:** `pendingSessionStart: Set<string>` — added on session reset events. `seenSessions: Set<string>` — tracks sessions that have sent at least one message. First-ever message from any session after bridge restart is treated as session start (catches the startup case, not just `/new`/`/reset`).

**Two paths:**

| Condition | Source | What's injected |
|-----------|--------|-----------------|
| Messages newer than latest daily | `messages` table (last 8, since daily timestamp) | `[HH:MM] role: content` lines, 2500 char soft cap |
| No newer messages (overnight) | Latest `daily_*.md` file | Full daily summary (~3000 chars, controlled by sleep prompt) |
| No daily exists at all | `messages` table (last 8) | `[HH:MM] role: content` lines, 2500 char soft cap |
| No daily, no messages | — | Nothing injected (null) |

**Recent messages cap:** 8 messages, 2500 char soft limit. Drops oldest messages first — newest message is never truncated. Never cuts mid-message.

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

**Steering:** `session-start.md` instructs the agent to greet the user by name (from `user_profile.md`) and reference the session context naturally.

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
| 1 | **Retrospective** | Reads full messages table. What went well/wrong, emotional attribution, lessons. Writes retro file + updates agent_notes |  |
| 2 | Purge expired garbage (>7d) | cascadeDelete |
| 3 | Immediate deletes (dupes, wrong-chat, STT) | cascadeDelete |
| 4 | Repeated probes | Garbage-mark → 7d grace |  |
| 5 | Noise marking | Garbage-mark → 7d grace |
| 6 | Verify-extract-mark | Creates extracted_memories, garbage-marks originals |
| 7 | Emotion harvest (verbal only) | Updates extracted_memories.emotion_score | **Changed scope** — reactions handled at runtime |
| 8 | **Flush old messages** | Delete messages older than 24h |  |
| 9 | Consolidation | working→daily→weekly→quarterly | **Made explicit** (was implicit in §2) |
| 10 | Report | Audit summary |

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
| agentbridge-store | `cli/agentbridge-store.ts` |
| agentbridge-sleep | `cli/agentbridge-sleep.ts` | Updated template with retro + flush. Removed `writeStartupGreeting` |
| SessionContext | `components/session-context.ts` | `buildSessionStartContext()` — session-start context injection |
| SleepTrigger | `sleep-trigger.ts` |
| SleepStateGatherer | `sleep-state-gatherer.ts` |
| sleep-prompt-loader | `sleep-prompt-loader.ts` |
| HeartbeatSystem | `heartbeat-system.ts` | Writes `.heartbeat` timestamp on each tick |
| EmbeddingProvider | `embedding-provider.ts` |
| VectorIndex | `vector-index.ts` |
| PromptScanner | `prompt-scanner.ts` |
| emotion-utils | `emotion-utils.ts` |
| Reaction handler | `main.ts` | **Enhanced:** immediate propagation to extracted_memories, `[REACT:emoji]` agent response support, skip reactions on synthetic messages (messageId 0) |

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
