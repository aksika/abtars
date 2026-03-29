# Local Memory — As-Built

> **Update rules:** This document reflects the CURRENT state of the system. When updating:
> - Never add historical notes ("was X", "changed from Y", "removed Z")
> - Never use strikethrough for deleted components — just remove the row
> - Never annotate with NEW/REMOVED/Unchanged — every line describes what exists NOW
> - If a component is deleted, delete its documentation entirely
> - Refactor history belongs in git commits and backlog, not here

---

## Overview

SQLite-backed persistence with FTS5 full-text search, ollama vector embeddings (Se sidecar), sleep-subagent-driven extraction, agent-initiated instant memory storage, unified memory editing (`agentbridge-edit`), Memory Darwinism, NATO Admiralty Code security model (CIA + AAA), emotion scoring with immediate propagation, daily retrospective with emotional attribution, and post-sleep wake-up prompt.

**Recall architecture**: Agent-driven via `agentbridge-recall` CLI. Session-start context injection via `buildSessionStartContext`.

---

## Memory Compartments

| ID | Name | Medium | Written By | Read By | Volatility |
|----|------|--------|------------|---------|------------|
| C0 | LLM Context Window | In-memory | Bridge (raw pass-through) | LLM | Ephemeral |
| C1 | Consolidated Summaries | Markdown files | Sleep subagent | Consolidation search, sleep subagent | Persistent — promoted up tiers |
| C2 | SQLite + FTS5 | `memory.db` | recordMessage(), agentbridge-store, agentbridge-edit | agentbridge-recall | messages: hot buffer (flushed after sleep). extracted_memories: persistent |
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

## extracted_memories Schema

The core knowledge table. Each row is a permanent fact, decision, preference, or event.

### Content fields

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `chat_id` | INTEGER | Source chat |
| `content_original` | TEXT | Memory in user's original language |
| `content_en` | TEXT | Memory translated to English |
| `memory_type` | TEXT | `fact`, `decision`, `preference`, `event` |
| `preserve_original` | INTEGER | 1 = instant-stored (preserve original wording) |
| `preserved_keyword` | TEXT | Original-language keyword for search |
| `source_message_ids` | TEXT | JSON array of message IDs this memory was extracted from |

### Timestamps

| Column | Type | Description |
|--------|------|-------------|
| `created_at` | INTEGER | When the memory was created (epoch ms). Canonical timestamp. |
| `source_timestamp` | INTEGER | Legacy column (NOT NULL). Same value as `created_at`. Not read by code. |
| `edited_at` | INTEGER | Last edit timestamp (NULL = never edited). Internal only, not in recall output. |
| `edited_by` | TEXT | Last editor ("kp" or "dreamy"). Internal only, not in recall output. |

### CIA-AAA Security Attributes

Based on the NATO Admiralty Code. See `docs/TODO/cia-aaa-memory-model.md` for full spec.

| Column | Type | Default | Scale | Description |
|--------|------|---------|-------|-------------|
| `classification` | INTEGER | 1 | 0-3 | **Confidentiality.** NATO classification level. |
| `trust` | INTEGER | 0 | 0-3 | **Authentication.** Source reliability (Admiralty A-F adapted). |
| `integrity` | INTEGER | 2 | 0-3 | **Provenance.** How far from ground truth. |
| `credibility` | INTEGER | 6 | 1-6 | **Information credibility.** Admiralty 1-6 scale. |

#### Classification (Confidentiality — who can see this?)

| Level | Label | Meaning |
|-------|-------|---------|
| 0 | UNCLASSIFIED | Safe anywhere — general facts, preferences |
| 1 | RESTRICTED | Default — operational memories |
| 2 | CONFIDENTIAL | Personal/sensitive — health, finances, relationships |
| 3 | SECRET | Tokens, credentials — NEVER disclosed, permanent |

Enforced at recall: `classification <= maxClassification`. SECRET (3) always excluded (hard cap at 2). Context-based: DM = up to CONFIDENTIAL, group/A2A = UNCLASSIFIED only.

#### Trust (Authentication — who created this?)

| Level | Label | Meaning |
|-------|-------|---------|
| 3 | owner | aksika via Telegram DM — `ALLOWED_USER_IDS` whitelist |
| 2 | self | KP's own extraction/observation |
| 1 | peer | A2A agents — known but autonomous |
| 0 | untrusted | Open web — no authentication |

Action gating: trust=0 never triggers autonomous actions. trust=1 non-destructive only. trust≥2 act freely. trust=3 full authority.

#### Integrity (Provenance — how far from source?)

| Level | Label | Meaning |
|-------|-------|---------|
| 0 | verbatim | User's exact words, unmodified |
| 1 | translated | KP translated from original language |
| 2 | extracted | KP summarized from conversation |
| 3 | compacted | KP merged multiple memories |

One-way chain: can only move toward compacted (higher number). Exception: translation fix can set to 1.

#### Credibility (Information accuracy)

| Level | Label | Meaning |
|-------|-------|---------|
| 1 | Confirmed | Corroborated by multiple sources |
| 2 | Probably true | Logical, consistent, not confirmed |
| 3 | Possibly true | Reasonable, single source |
| 4 | Doubtful | Possible but no corroboration |
| 5 | Improbable | Contradicted by other memories |
| 6 | Unknown | No basis to evaluate (default) |

Conflict resolution: higher trust wins → higher credibility wins → more recent wins → ask aksika.

### Emotion Score

| Column | Type | Default | Scale | Description |
|--------|------|---------|-------|-------------|
| `emotion_score` | INTEGER | 0 | -5 to +5 | Emotional weight. Negative = frustration/anger, positive = satisfaction/joy. |

#### How emotions enter the system

| Source | Path | When |
|--------|------|------|
| Emoji reactions | `updateEmotionByPlatformId()` → `editMemory()` | Runtime — user reacts on Telegram/Discord |
| Instant store | `agentbridge-store --emotion-score N` | Runtime — agent stores emotionally significant memory |
| Extraction | LLM assigns emotion during `MemoryExtractor` | Heartbeat/sleep extraction |
| Verbal harvest | `agentbridge-edit --memory-id N --emotion-score N --caller dreamy` | Sleep §6 — Dreamy scans for verbal emotional reactions |

Emoji reactions propagate immediately: message table updated → cascade to linked extracted_memories via `editMemory()`. Verbal emotions (e.g. "fasza!", "goddamn it!") are harvested during sleep and applied to the nearest relevant memory.

### Memory Darwinism

Survival-of-the-fittest for memories. Frequently recalled memories get stronger; unused ones fade and get pruned.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `recall_count` | INTEGER | 0 | Incremented on every recall hit |
| `last_recalled_at` | INTEGER | NULL | Timestamp of last recall |
| `relevance_score` | INTEGER | 0 | Boosted/demoted by feedback, affects recall ranking |
| `confidence` | INTEGER | 3 | 1-5, adjusted based on evidence |

**Recall scoring boost:** `base_score × (1 + recall_count × 0.1) × (relevance > 0 ? 1.2 : 1.0)`.

**Sleep §2 feedback pass:** If a recalled memory was confirmed by user → boost (+10 relevance). If corrected/rejected → demote (-10 relevance).

**Sleep §7 fitness review:** Zero recall after 60+ days → candidate for deletion. Low confidence + zero recall → first to prune. High recall + negative relevance → candidate for rewording.

### Embedding

| Column | Type | Description |
|--------|------|-------------|
| `embedding` | BLOB | 768-dim float32 vector (nomic-embed-text via ollama). NULL until embedded. |

Nulled automatically on content edit (re-embedded on next batch run).

### FTS5 Indexes

| Table | Indexed column | Tokenizer | Triggers |
|-------|---------------|-----------|----------|
| `extracted_memories_fts` | `content_en` | porter unicode61 | INSERT, DELETE, UPDATE |
| `extracted_memories_original_fts` | `content_original` | unicode61 | INSERT, DELETE, UPDATE (preserve_original=1 only) |

---

## System Layer Architecture

```
+---------------------------------------------------------------------+
|  Layer 7: Overnight Maintenance                                      |
|  agentbridge-sleep, SleepTrigger, SleepStateGatherer,               |
|  sleep-prompt-loader, sleeping_prompt.md template                    |
+---------------------------------------------------------------------+
|  Layer 5: Agent-Initiated Recall (single path)                       |
|  agentbridge-recall ONLY (7-stage cascade, extracted-first)          |
+---------------------------------------------------------------------+
|  Layer 4: Background Extraction & Enrichment                        |
|  HeartbeatSystem, agentbridge-store (Instant Store),                 |
|  agentbridge-edit (Unified Memory Mutation),                         |
|  MemoryExtractor (sleep-driven)                                      |
+---------------------------------------------------------------------+
|  Layer 3: Consolidation (subagent-driven)                           |
|  working → daily → weekly → quarterly                                |
+---------------------------------------------------------------------+
|  Layer 2: Indexing & Search Primitives                              |
|  MemoryIndex (FTS5), VectorIndex, EmbeddingProvider                 |
|  FTS5 triggers: INSERT, DELETE, UPDATE (content_en + content_original)|
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

Se sidecar: gated by `EMBEDDING_ENABLED=true`. Fires async at S1 start (~20-50ms via ollama), result consumed after S3. Zero added latency.

**Hit-rate logging:** Per-stage hit counts emitted to stderr.

### Embedding Lifecycle (C5)

Model: `nomic-embed-text` via ollama (768 dimensions, CPU-only, ~20-50ms/query, fully local). Gated by `EMBEDDING_ENABLED=true`.

| Event | What happens |
|-------|-------------|
| `agentbridge-store` (instant) | `embedNewMemory()` — fire-and-forget after INSERT |
| `agentbridge-edit` (content change) | Embedding nulled → re-embedded on next batch |
| Dreamy extraction (sleep) | `embedBatch()` — embeds all new memories after INSERT |
| `agentbridge-embed` CLI | One-time batch embed of all memories with NULL embedding |
| Recall (Se sidecar) | `embedText(query)` fired async at S1, cosine similarity after S3 |

Storage: `embedding` BLOB column on `extracted_memories` (768 × 4 bytes = 3KB per memory). Threshold: 0.5 cosine similarity.

### Entity Linking

Tables: `entities` (name, type, summary) + `memory_entities` (memory_id, entity_id junction).

Entities are tagged during extraction — the LLM identifies named entities per memory. Recall supports `--entity "Name"` filter.

---

## Memory Edit Tool (`agentbridge-edit`)

Source: `src/cli/agentbridge-edit.ts`
Method: `MemoryManager.editMemory()` — single unified mutation path for all extracted_memory field updates.

### Lookup modes

- `--memory-id N` — direct extracted_memory ID
- `--message-id N --chat-id C` — find memories linked via `source_message_ids`, edit all matches

### Two-tier usage for KP

| Tier | Fields | When to use |
|------|--------|-------------|
| Attribute edits (free) | trust, credibility, classification, integrity, confidence, emotion_score, relevance_score, keyword, memory_type | Whenever evidence supports it |
| Content edits (restricted) | content_en, content_original | Only when user explicitly stresses immediate correction |
| Translation fixes (free) | content_en + integrity=1 | When content_en is clearly a bad translation but the fact is correct |

### Attribute editing rules (CIA-AAA)

- **classification**: escalate freely. Declassify only 2→1. SECRET (3) locked without `--user-override`.
- **trust**: set 0-2 freely. Set 3 only when user explicitly stated the fact.
- **credibility**: improve/degrade based on evidence. 1 (confirmed) needs corroboration.
- **integrity**: one-way toward compacted. Exception: translation fix → 1 (translated).
- **relevance_score**: supports relative delta (`+10`, `-10`) and absolute values.

### Audit fields (set automatically, not editable, not in recall output)

- `edited_at` — timestamp of last edit (NULL = never edited)
- `edited_by` — caller name ("kp" or "dreamy"), last edit overwrites

### Safety

- Prompt injection scan on content edits
- `--dry-run` previews changes without committing
- Content change → embedding nulled automatically

### Internal routing

`adjustRelevance()`, `reclassifyMemory()`, `updateEmotionByPlatformId()` delegate to `editMemory()` internally. Sleep §6 (emotion harvest) and §7 (translation fix) use `agentbridge-edit` CLI.

---

## Session Context Window

What the agent sees when a new session starts:

### Layer 1: Agent system prompt
- `professor.json` → `"You are Kiro Professor. Follow your SOUL.md identity."`
- All built-in kiro-cli tools available

### Layer 2: Steering resources (`~/.agentbridge/.kiro/steering/**/*.md`)

| Type | Files | Loading |
|------|-------|---------|
| `alwaysApply: true` | `TOOLS.md` | Always in system prompt |
| No skill frontmatter | `SOUL.md`, `session-start.md` | Loaded as resources — always available |
| Skill files (`name:` frontmatter) | ~15 skills | On-demand — agent sees skill list, invokes when needed |

### Layer 3: Session-start context (first message only)

Prepended to the user's first message by `buildSessionStartContext()`:

| Condition | Source | What's injected |
|-----------|--------|-----------------|
| Messages newer than latest daily | `messages` table (last 8) | `[HH:MM] role: content` lines, 2500 char soft cap |
| No newer messages (overnight) | Latest `daily_*.md` file | Full daily summary (~3000 chars) |
| No daily, no messages | — | Nothing injected |

### Layer 4: User message

Prefixed with platform tag: `[Telegram] <message>` or `[Discord] [username] in #channel: <message>`.

---

## Multi-Platform Architecture

### Isolation: Separate context windows (C0)

Each platform+channel gets its own ACP session (keyed `telegram:<chatId>` or `discord:<channelId>`). Context windows never mix.

### Shared: One memory (C2, C1, C4, C6)

All platforms write to the same SQLite database. Facts learned on Telegram are recallable from Discord and vice versa. Messages tagged with `[Telegram]`/`[Discord]` prefixes.

### Core files

`~/.agentbridge/memory/core/user_profile.md` and `agent_notes.md` are injected into every session on every platform.

---

## Sleep Cycle — Dreamy

The sleep agent (Dreamy) is KP running with `sleeping_prompt.md` as a dedicated maintenance subagent. Spawned as a detached `kiro-cli acp` process. Performs 10 steps of memory maintenance, garbage collection, consolidation, and self-reflection.

### Trigger (`SleepTrigger` in `sleep-trigger.ts`)

Registered as `sleep-trigger` task in HeartbeatSystem (5-min interval).

**Startup:** runs if no audit file exists for today AND last audit is >25h old (or ≥8am).

**Cron (heartbeat tick):** runs if ≥8am, 10min idle, and no audit today.

**Retry on failure:** up to 3 attempts per 24h cycle. Writes `.lock` file to prevent duplicate spawns.

### State Snapshot

Before sleep starts, `SleepStateGatherer` collects system state and injects it into the prompt template:
- DB stats: message count, extracted memory count, embedding coverage, compression ratio
- Darwinism stats: avg recall count, avg relevance, never-recalled count, recalled-last-30d
- FTS5 health: integrity-check on all 3 FTS tables
- Disk usage vs budget
- Working directory contents
- Topic files list
- Last sleep audit timestamp
- Todo and cron contents

### Steps

| Step | What | Behavior |
|------|------|----------|
| §1 | Retrospective | Reads full messages table. What went well/wrong, emotional attribution, lessons. Writes `retrospectives/retro_YYYYMMDD.md` + updates `core/agent_notes.md` |
| §2 | Feedback Pass | Reviews recalled memories from today's conversations. User confirmed → `agentbridge-edit --memory-id N --relevance-score +10 --caller dreamy`. User corrected → `--relevance-score -10`. |
| §3 | Reminder & Todo Extraction | Scans for missed "remind me" / "ne felejtsd" patterns. Adds to todo via `agentbridge-todo`. |
| §4 | Garbage Collection | 7-step GC (see below) |
| §4+ | Database Maintenance | WAL checkpoint, FTS5 rebuild if corrupt, batch-embed NULL embeddings |
| §5 | Cron Verification | Cross-check time-specific reminders against cron entries |
| §6 | Topic Reorg | Review topic files for staleness or merge opportunities |
| §7 | Fitness Review | Darwinism review, core knowledge maintenance, translation quality check via `agentbridge-edit` |
| §8 | Memory Merge | Find and merge near-duplicate memories (max 5 per cycle) via `agentbridge-store --merge` |
| §9 | Consolidation | working→daily→weekly→quarterly summaries. Classification-aware: CONFIDENTIAL/SECRET content redacted. |
| §9.5 | Media Cleanup | FIFO 100MB cleanup of `~/.agentbridge/received/` |
| §10 | Report | Audit summary written to `sleep/sleep_YYYYMMDD_HHmm.md` |

### Garbage Collection (§4)

Dreamy scans all messages in the DB and cleans up noise while preserving emotional signals.

**Step 1 — Purge expired garbage:** Read `garbage.json`, delete messages marked >7 days ago via `agentbridge-store --delete-ids`.

**Step 2 — Immediate deletes (no grace period):**
- Duplicates: same content, same chat, within 5 minutes → keep first, delete rest
- Wrong-chat messages: user says "wrong chat" / "rossz chat" → delete message + the one before it + both responses
- Whisper/STT garbage: garbled transcriptions that make no sense in any language

**Step 3 — Repeated probes:** Same question 3+ times → keep first occurrence + response, mark rest as garbage.

**Step 4 — Noise marking (7-day grace period):** Single-word greetings, pings, filler acknowledgments → mark in `garbage.json`. Does NOT mark action confirmations, instructions, or questions with real content.

**Step 5 — Verify extractions:** Scan messages not yet captured in `extracted_memories`. Extract missing facts via `agentbridge-store`. After confirming facts are stored, garbage-mark the verbose originals.

**Step 6 — Emotion harvest (verbal only):** Scan for verbal emotional reactions ("fasza!", "goddamn it!"). Update nearest relevant memory's `emotion_score` via `agentbridge-edit --memory-id N --emotion-score N --caller dreamy`. Mark the emotional message as garbage. (Emoji reactions are already handled at runtime.)

**Step 7 — Flush old messages:** Delete all messages older than 24 hours. By this point, all valuable content has been extracted, summarized, and captured in the retrospective.

### Safety

- Both user AND paired assistant messages are garbage-marked/deleted together
- 7-day grace period on noise marks (dupes/wrong-chat/STT are immediate)
- `chat_backup` table is never touched — immutable audit trail
- Emotion scores are harvested before deletion — no signal loss
- Classification-aware: SECRET/CONFIDENTIAL content redacted in summaries

### Fitness Review (§7)

Darwinism-based memory health check:
- **High recall + high relevance** → no action
- **High recall + negative relevance** → candidate for rewording via `agentbridge-edit`
- **Zero recall after 60+ days** → candidate for deletion
- **Low confidence (1-2) + zero recall** → first to prune
- **Translation quality check:** Scan for `content_en` containing untranslated foreign words → fix via `agentbridge-edit --memory-id N --translated "..." --integrity 1 --caller dreamy`
- **Core knowledge maintenance:** Review `user_profile.md` and `agent_notes.md`, keep each ≤10 lines

### Post-Sleep Wake-Up

After successful sleep (both startup and cron-triggered), the bridge injects a wake-up prompt to KP via Telegram: "You just woke up.. how did you sleep buddy?" — KP responds naturally, referencing the sleep audit and retro.

### Key Files

| File | Purpose |
|------|---------|
| `persona/sleeping_prompt.md` | Full sleep prompt template (10 steps) |
| `src/components/sleep-trigger.ts` | Heartbeat task, trigger logic, retry |
| `src/components/sleep-state-gatherer.ts` | Collects system state for prompt |
| `src/components/sleep-prompt-loader.ts` | Template variable substitution |
| `src/cli/agentbridge-sleep.ts` | CLI entry point, spawns kiro-cli |
| `~/.agentbridge/memory/garbage.json` | GC tracking: `{"<msg_id>": "<ISO timestamp>"}` |
| `~/.agentbridge/memory/sleep/` | Audit logs + lock files |
| `~/.agentbridge/memory/retrospectives/` | Daily self-reflections |

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
[Reaction arrives → messages.emotion_score updated → propagated to extracted_memory via editMemory]
    │
    ▼
[Sleep cycle]
    │
    ├── §1: Retrospective reads full messages (raw + emotion_score)
    ├── §2: Feedback pass — boost/demote recalled memories
    ├── §4: GC — noise marking, emotion harvest, flush >24h messages
    ├── §4+: Verify extractions → facts move to extracted_memories
    ├── §7: Fitness — prune weak memories, fix translations
    │
    ▼
[After sleep: messages table is compact (today only)]
[extracted_memories has all permanent knowledge with CIA-AAA attributes]
[retrospectives/ has daily self-reflection]
[daily/weekly/quarterly/ has consolidated summaries]
[Wake-up prompt sent to KP]
```

---

## Component Inventory

| Component | File | Description |
|-----------|------|-------------|
| MemoryManager | `memory-manager.ts` | Top-level coordinator. Owns SQLite DB, FTS index, editMemory(), instantStore(), merge, cascadeDelete. |
| MemoryIndex | `memory-index.ts` | FTS5 search + Darwinism recall counting. Emoji-stripped at index level. |
| MemoryExtractor | `memory-extractor.ts` | LLM-driven extraction from conversations. Entity tagging. Sleep-driven. |
| agentbridge-recall | `cli/agentbridge-recall.ts` | 7-stage cascade recall, extracted-first, keyword-free fallback, short-circuit. |
| agentbridge-store | `cli/agentbridge-store.ts` | Instant memory storage. Prompt injection scan. Boost/demote/reclassify/merge/delete (legacy, delegating to editMemory). |
| agentbridge-edit | `cli/agentbridge-edit.ts` | Unified memory mutation. Edit by `--memory-id` or `--message-id`. Classification guards, dry-run, prompt injection scan. |
| agentbridge-sleep | `cli/agentbridge-sleep.ts` | Sleep cycle orchestrator. Spawns kiro-cli with sleeping_prompt.md template. |
| SessionContext | `session-context.ts` | `buildSessionStartContext()` — session-start context injection. |
| SleepTrigger | `sleep-trigger.ts` | Heartbeat task. Startup + cron trigger with retry logic. |
| SleepStateGatherer | `sleep-state-gatherer.ts` | Gathers DB stats, FTS5 health, disk usage for sleep prompt. |
| HeartbeatSystem | `heartbeat-system.ts` | 5-min tick. Runs sleep-trigger, cron, self-healer, reminder-injector. |
| EmbeddingProvider | `embedding-provider.ts` | ollama nomic-embed-text wrapper. |
| VectorIndex | `vector-index.ts` | Cosine similarity search over embedded memories. |
| PromptScanner | `prompt-scanner.ts` | 22-pattern prompt injection detector. Used by store, edit, A2A. |
| emotion-utils | `emotion-utils.ts` | `clampEmotionScore()` — clamps to -5..+5 range. |

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_ENABLED` | `true` | Enable/disable memory system |
| `MEMORY_DIR` | `~/.agentbridge/memory` | Memory storage directory |
| `EMBEDDING_ENABLED` | `false` | Enable ollama vector embeddings |
| `EMBEDDING_SIMILARITY_THRESHOLD` | `0.5` | Cosine similarity threshold for Se sidecar |
| `DEBUG_MODE` | `false` | Enables chat_backup writes |
| `MEMORY_RECALL_SHORT_CIRCUIT` | `true` | Toggle short-circuit in recall cascade |
| `MEMORY_DISK_BUDGET_MB` | `500` | Disk budget for memory directory |
| `MEMORY_FORGET_THRESHOLD` | `0.8` | Relevance threshold for topic-based forgetting |

---

## File System Layout

```
~/.agentbridge/memory/
  memory.db                    # SQLite: messages (hot buffer) + extracted_memories (permanent)
  context-window-start.json    # Per-chat session boundary timestamps
  .heartbeat                   # Epoch ms — written by HeartbeatSystem on each tick
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
    user_profile.md            # Who the user is (injected every session)
    agent_notes.md             # Lessons learned (updated by retrospective)
  sleep/
    sleep_YYYYMMDD_HHmm.md    # Sleep cycle audit logs
    sleep_YYYYMMDD.lock        # Sleep spawn lock (prevents duplicates)
```

---

## Test Coverage

729 tests across 73 files.
