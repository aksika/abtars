# Local Memory — As-Built

> **Update rules:** This document reflects the CURRENT state of the system. When updating:
> - Never add historical notes ("was X", "changed from Y", "removed Z")
> - Never use strikethrough for deleted components — just remove the row
> - Never annotate with NEW/REMOVED/Unchanged — every line describes what exists NOW
> - If a component is deleted, delete its documentation entirely
> - Refactor history belongs in git commits and backlog, not here

---

## Overview

Standalone memory package (`@agentbridge/memory`, ABM v2). 38 source + 29 test files in `src/memory/`, zero bridge dependencies. Public API via `IMemorySystem` interface — consumers program against the interface, `MemoryManager` is the concrete implementation.

SQLite-backed persistence with FTS5 (porter on content_en) + trigram FTS5 (content_en + content_original, diacritics-stripped), ollama vector embeddings with int8 quantization (1536→384 bytes after 14d) in separate `memory_embeddings` table, 256-bit binary signatures (Hamming search, no ollama needed), ABM-L v2 compressor (entity whitelist, topic inference, no truncation), emotion tagging (25 types), importance flags (8 types), auto-promote |emotion| ≥ 4 to core tier, Memory Darwinism, CIA+AAA security.

Two-tier aging: Original NULLed after 90d (source of truth kept longer), content_en preserved forever (trigram search depends on it). ABM-L + int8 embeddings + signatures persist forever. Pressure-based acceleration as DB approaches `MEMORY_MAX_DB_SIZE_MB`. Flashbulb memories (|emotion| ≥ 4 + pivot/correction) never aged.

Sleep maintenance (Dreamy) is an optional addon — memory works without it. Sleep calls memory via `IMemorySystem` maintenance methods. Triggered by `BED_TIME` + quiet ticks (no bridge restart). 24 sleep steps including topic assignment, core promotion, temporal review, emotion/flags backfill, ABM-L compression, contradiction check, emotional arcs, memory aging, entity review.

### Package boundary

| Aspect | Detail |
|---|---|
| Files | 38 source + 29 test files in `src/memory/` |
| External imports | Zero — fully self-contained |
| Entry point | `src/memory/index.ts` |
| Interface | `IMemorySystem` (lifecycle, messages, search, emotion, stats, maintenance) |
| Heartbeat | `IHeartbeat` interface — bridge injects its implementation |
| Logger | `setLogger()` injection — bridge injects its logger at startup |
| Types | `mem-types.ts` — all memory types owned by the package |
| Tests | 90 test files, ~902 tests |

**Recall architecture**: Agent-driven via `agentbridge-recall` CLI. Session-start context injection via `buildSessionStartContext`.

---

## Memory Compartments

| ID | Name | Medium | Written By | Read By | Volatility |
|----|------|--------|------------|---------|------------|
| C0 | LLM Context Window | In-memory | Bridge (raw pass-through) | LLM | Ephemeral |
| C1 | Consolidated Summaries | Markdown files | Sleep subagent | Consolidation search, sleep subagent | Persistent — promoted up tiers |
| C2 | SQLite + FTS5 | `memory.db` | recordMessage(), agentbridge-store, agentbridge-edit | agentbridge-recall | messages: hot buffer (max 1000, aged >10d). extracted_memories: persistent |
| C4 | Markdown Knowledge Files | Flat files | Agent, retrospective | Sleep subagent | Persistent |
| C5 | Embeddings | `memory.db` (`memory_embeddings` table) | ollama nomic-embed-text (on insert + batch) | recall-engine Se sidecar | Persistent — float32 quantized to int8 after 14d. Gated by `EMBEDDING_ENABLED` |
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
|  search) |--- recall --------->|  (single path: agentbridge-recall, Sf + Ss + Se + S6)
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
| Extraction | LLM assigns emotion during Dreamy sleep extraction | Sleep §4 step 5 |
| Verbal harvest | `agentbridge-edit --memory-id N --emotion-score N --caller dreamy` | Sleep §6 — Dreamy scans for verbal emotional reactions |
| Retro extract | `agentbridge-store --emotion-score N` or `agentbridge-edit --emotion-score N` | Sleep §5.5 — lessons/mistakes from retrospective. Repeated mistakes escalate by -2. |

Emoji reactions propagate immediately: message table updated → cascade to linked extracted_memories via `editMemory()`. Verbal emotions (e.g. "fasza!", "goddamn it!") are harvested during sleep and applied to the nearest relevant memory.

### Memory Darwinism

Survival-of-the-fittest for memories. Frequently recalled memories get stronger; unused ones fade and get pruned.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `recall_count` | INTEGER | 0 | Incremented on every recall hit |
| `last_recalled_at` | INTEGER | NULL | Timestamp of last recall |
| `relevance_score` | INTEGER | 0 | Boosted/demoted by feedback, affects recall ranking |
| `confidence` | INTEGER | 3 | 1-5, adjusted based on evidence |

**Recall scoring boost:** `base_score × (1 + recall_count × 0.1) × (relevance > 0 ? 1.2 : 1.0) × recency_factor × emotion_boost`.

**Time-decay (recency_factor):** `max(0.3, 1 - age_days / 365)` — linear decay over a year, floor at 0.3. Recent memories rank higher.

**Emotion override (emotion_boost):** `1 + abs(emotion_score) × 0.1` — emotional memories resist decay. A +5 emotion memory decays 1.5x slower than neutral.

Configurable: `RECALL_DECAY_DAYS` (365), `RECALL_DECAY_FLOOR` (0.3), `RECALL_EMOTION_BOOST` (0.1).

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
| `content_en_trigram` | `strip_diacritics(content_en \|\| preserved_keyword)` | trigram | INSERT, DELETE, UPDATE |
| `content_original_trigram` | `strip_diacritics(content_original)` | trigram | INSERT, DELETE, UPDATE |

---

## System Layer Architecture

```
+---------------------------------------------------------------------+
|  Layer 7: Overnight Maintenance                                      |
|  agentbridge-sleep, SleepTrigger, SleepStateGatherer,               |
|  sleep-prompt-loader, sleeping_prompt.md template                    |
+---------------------------------------------------------------------+
|  Layer 5: Agent-Initiated Recall (single path)                       |
|  agentbridge-recall ONLY (4-stage: Sf + Ss + Se + S6)                |
+---------------------------------------------------------------------+
|  Layer 4: Storage & Mutation                                        |
|  agentbridge-store (Instant Store),                                  |
|  agentbridge-edit (Unified Memory Mutation)                          |
|  Extraction: Dreamy (sleep §4 step 5) via agentbridge-store          |
+---------------------------------------------------------------------+
|  Layer 3: Consolidation (subagent-driven)                           |
|  working → daily → weekly → quarterly                                |
+---------------------------------------------------------------------+
|  Layer 2: Indexing & Search Primitives                              |
|  MemoryIndex (FTS5 porter), trigram-search (FTS5 trigram),          |
|  ollama-embed (Se sidecar), signature-generator (Ss)                |
|  FTS5 triggers: INSERT, DELETE, UPDATE (porter + trigram)            |
+---------------------------------------------------------------------+
|  Layer 1: Storage & Persistence                                     |
|  SQLite ONLY (memory.db), File System                               |
+---------------------------------------------------------------------+
```

---

## Recall Pipeline (`recall-engine.ts`, Sf + Ss + Se + S6)

Source: `src/memory/recall-engine.ts`, `src/memory/trigram-search.ts`
CLI wrapper: `src/cli/agentbridge-recall.ts`
Dashboard: `src/components/memory-search-controller.ts` (delegates to recall-engine, takes MemoryManager)

### Design Philosophy

Four non-overlapping stages, each using a fundamentally different search method on a distinct data source. No redundancy. Priority ordering with MMR reranking for diversity.

### Stages

| Stage | Source | Method | What it catches | Score |
|-------|--------|--------|-----------------|-------|
| Sf.1 | `extracted_memories_fts` | Porter FTS5 on content_en | Morphological variants: deploy/deployed/deploying | Darwinism-boosted |
| Sf.2 | `content_en_trigram` | Trigram FTS5 (diacritics-stripped) on content_en + preserved_keyword | Substrings, accent-insensitive matches, agent-flagged terms | Darwinism-boosted |
| Sf.3 | `content_original_trigram` | Trigram FTS5 (diacritics-stripped) on content_original (fallback) | Untranslated Hungarian queries, typos in original language | Darwinism-boosted |
| Ss | `extracted_memories.signature` | Binary signature Hamming distance (cap 5, threshold 0.65) | Semantic similarity without ollama | 0.0-1.0 similarity |
| Se | `memory_embeddings` | Embedding cosine similarity (ollama) | Best semantic quality | 0.0-1.0 similarity |
| S6 | daily/weekly/quarterly .md files | Substring match on file content | Consolidation summaries, narrative context | 0.5 (fixed) |

### Pipeline Flow

```
Query → strip_diacritics(query)
  │
  ├── Se: fire async at start (optional, needs ollama)
  │
  ├── Sf: three-query fuzzy search
  │     1. Porter FTS5 on content_en (stemmed keyword match, ~1ms)
  │     2. Trigram on content_en + preserved_keyword (diacritics-stripped, ~1ms)
  │        Fallback chain: full word → z↔y QWERTZ swap → substring windows
  │     3. If results < limit: trigram on content_original (Hungarian fallback, ~1ms)
  │        Same fallback chain: full word → z↔y swap → substring windows
  │
  ├── Ss: signature Hamming (skip if Sf filled limit)
  │     Threshold 0.65, capped at 5 results
  │
  ├── Se: await + merge (skip if Sf filled limit)
  │
  ├── S6: consolidation grep (always runs — different data source)
  │
  ├── Dedup: by memory ID (higher-priority stage wins)
  │
  └── MMR reranking (λ=0.7) — prevents topic clustering
      No S7 fallback — return empty on zero results.
```

### Trigram Fallback Chain

When a full-word trigram query returns zero results:
1. **z↔y QWERTZ swap** — "hogz" → "hogy" (Hungarian keyboard layout)
2. **Substring windows** — split word into overlapping half-length windows. "válókezelő" → "valok", "okeze", "kezel", "ezelo". Common suffix "kezelo" matches "valtokezelo" despite the typo.

Each fallback only fires if the previous returned nothing. Zero latency cost on normal queries.

### Embedding Lifecycle (C5)

Model: `nomic-embed-text` via ollama (768 dimensions, CPU-only, ~20-50ms/query, fully local). Gated by `EMBEDDING_ENABLED=true`.

| Event | What happens |
|-------|-------------|
| `agentbridge-store` (instant) | `embedNewMemory()` — fire-and-forget after INSERT |
| `agentbridge-edit` (content change) | Embedding nulled → re-embedded on next batch |
| Dreamy extraction (sleep) | `embedBatch()` — embeds all new memories after INSERT |
| `agentbridge-embed` CLI | One-time batch embed of all memories with NULL embedding |
| Recall (Se sidecar) | `embedText(query)` fired async at S1, cosine similarity after S3 |

Storage: separate `memory_embeddings` table (memory_id PK, embedding BLOB, quantized INTEGER). float32 (768 × 4 = 3KB) quantized to int8 (384 bytes) after `MEMORY_EMBEDDING_QUANTIZE_DAYS` (default 14d) via `ageMemoryTiers()`. Threshold: 0.5 cosine similarity. int8 search via `cosineSimInt8()`.

### Entity Linking

Tables: `entities` (name, type, summary) + `memory_entities` (memory_id, entity_id junction).

Entities are tagged during extraction — the LLM identifies named entities per memory. Recall supports `--entity "Name"` filter.

---

## Memory Edit Tool (`agentbridge-edit`)

Source: `src/cli/agentbridge-edit.ts`
Method: `MemoryEditor.editMemory()` — single unified mutation path for all extracted_memory field updates.

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

The sleep agent (Dreamy) is KP running as a dedicated maintenance subagent. Spawned as a **non-detached** `kiro-cli acp` child process (dies with bridge — no orphans). The sleep cycle is a **multi-turn conversation** — a series of focused prompts sent sequentially into the same session, each handling one maintenance task.

### Architecture

```
Transport spawns → Session created (one kiro-cli process)

Prompt 0:  Identity + rules + state snapshot
Prompt 1:  §1 Retrospective
Prompt 2:  §2 Feedback pass
...
Prompt 14: §10 Report (self-review + write audit)

Transport destroyed → Wake-up prompt to KP
```

Same session, same context window. Each step's response accumulates in context, so later steps know what earlier steps did. Zero extra kiro-cli spawns. Monolith `sleeping_prompt.md` kept as fallback if step files not deployed.

### Unsupervised Rules

Established in the identity prompt (00-identity.md):
- No human in the conversation — do not ask questions or wait for confirmation
- Act on best judgment
- If unsure about destructive actions → skip and flag
- Accumulate "Flagged for Review" items throughout all steps → KP picks up on wake-up

### Trigger

Sleep runs on bridge startup (not heartbeat). On every bridge start:

1. Check `hasSleepAuditToday()` — if audit `.md` exists with all steps ok, skip
2. Spawn `agentbridge-sleep` as background child process (non-detached)
3. On failure: retry via `setTimeout` (5min delay, max 3 attempts)
4. On success: log, reset ctx starts

**Guard against re-run:** `hasSleepAuditToday()` checks for today's audit file. Deploys restart the bridge but sleep only runs once per day. Partial completions (lock file with failed steps) allow retry.

**Duplicate prevention:** `sleepChild` in-memory guard — if one is running, another won't spawn.

**Sleep and main transport:** Sleep uses its own AcpTransport. Main transport stays responsive — user messages go straight through during sleep, no queueing.

### Lock File Lifecycle

Lock files are date-scoped (`sleep_YYYYMMDD.lock`). Each day gets its own file.

**Same-day resume:** If sleep is re-triggered on the same day (bridge restart, heartbeat retry), the lock file preserves step state. Steps with status `ok` or `skipped` are skipped on resume. Steps with `failed`/`timeout`/`pending` are re-run.

**Cross-day catch-up:** On sleep start, the orchestrator scans for previous days' lock files before running today's cycle:
- All essential steps ok → delete lock (cleanup)
- Essential steps failed → run catch-up (04a with date-range query, 04b from daily file, retro/retro-extract via prompt)
- Catch-up succeeds → delete lock
- Catch-up fails → keep lock, log WARNING with step name and consecutive failure count
- Lock older than 3 days → log ERROR, delete (data too stale to recover)

**Essential steps** (time-sensitive, data lost if skipped): `04a-daily-summary`, `04b-extract-from-daily`, `retrospective`, `retro-extract`.

**Idempotent steps** (today's run catches up naturally): all others (GC, merge, darwinism, consolidation, etc.).

### Per-Step Retry

Each step gets up to 3 attempts with 5-min timeout. Failed steps are logged but don't kill the cycle — the orchestrator moves to the next step. This is the key improvement over the monolith where a timeout at step 3 meant steps 4-14 never happened.

### Conditional Skip Logic (TypeScript)

The CLI decides which steps to skip based on the state snapshot:

| Step | Skip condition |
|------|---------------|
| §2 Feedback | No `agentbridge-recall` invocations in today's messages |
| §4+ DB Maintenance | FTS healthy AND no NULL embeddings |
| §6 Topic Reorg | No topic files exist |
| §8 Merge | <10 extracted memories |
| §9.5 Media Cleanup | No `received/` directory |

### State Snapshot

Before sleep starts, `SleepStateGatherer` collects system state and injects it into the identity prompt:
- DB stats: message count, extracted memory count, embedding coverage, compression ratio
- Darwinism stats: avg recall count, avg relevance, never-recalled count, recalled-last-30d
- FTS5 health: integrity-check on all 3 FTS tables
- Disk usage vs budget
- Working directory contents, topic files, todo and cron contents

### Steps

| # | File | Step | Behavior |
|---|------|------|----------|
| 0 | `00-identity.md` | Identity | Who Dreamy is, rules, tools, state snapshot |
| 1 | `01-retrospective.md` | §1 Retrospective | Read messages, write retro, emotional attribution, update agent_notes |
| 2 | `02-feedback.md` | §2 Feedback | Boost/demote recalled memories via `agentbridge-edit` |
| 3 | `03-reminders.md` | §3 Reminders | Extract todos via `agentbridge-todo` |
| 4a | `04a-daily-summary.md` | §4a Daily Summary | **Code-driven.** Batched summarization → `daily/daily_YYYYMMDD.md`. If yesterday has no daily file but has messages, targets yesterday (human day cycle: midnight–2am is still "today"). |
| 4b | `04b-extract-from-daily.md` | §4b Extract from Daily | **Code-driven.** Model reads daily file, calls `agentbridge-store` |
| 4c | `04c-gc-noise.md` | §4c GC Noise | Mark small talk/noise as garbage |
| 5 | `06-cron-verify.md` | §5 Cron Verify | Cross-check reminders against cron entries |
| 6 | `07-topic-reorg.md` | §6 Topic Reorg | Topic file maintenance |
| 7 | `08a-darwinism.md` | §7 Darwinism | Fitness review, prune weak memories |
| 7b | `08b-core-knowledge.md` | §7b Core Knowledge | Review core knowledge files |
| 7c | `08c-translation-check.md` | §7c Translation | Fix bilingual memory quality |
| 8 | `09-anomaly-audit.md` | §7.5 Anomaly Audit | CIA-AAA attribute audit (daily) |
| 9 | `10-retro-extract.md` | §5.5 Retro Extract | Extract lessons/mistakes from retro with emotion scoring. Dedup via recall, escalate emotion on repeated mistakes. |
| 10 | `11-merge.md` | §8 Merge | Near-duplicate memory merge (max 5) |
| 11 | `12-consolidation.md` | §9 Consolidation | Weekly/quarterly rollups only (daily done in 04a) |
| 12 | `13-media-cleanup.md` | §9.5 Media Cleanup | FIFO 100MB cleanup |
| 13 | `14-report.md` | §10 Report | Self-review, fix missed items, write audit |
| 14 | `15-skill-review.md` | §8d Skill Review | Review conversations for reusable patterns, create/update auto-skills via `agentbridge-skill` |
| 15 | `16-topic-assignment.md` | §8e Topic Assignment | Tag untagged memories with topics via `agentbridge-edit --topic` |
| 16 | `17-core-promotion.md` | §8f Core Promotion | Promote best general → core tier via `agentbridge-edit --tier core` (budget: 100 entries) |
| 17 | `18-temporal-review.md` | §8g Temporal Review | Invalidate stale core facts via `agentbridge-edit --valid-to` |
| 18 | `19-emotion-flags.md` | §8h Emotion/Flags Backfill | Backfill emotion_tags + importance_flags on legacy memories |
| 19 | `20-compress-backfill.md` | §8i Compression Backfill | ABM-L compress memories lacking content_compressed |
| 20 | `21-contradiction.md` | §8j Contradiction Check | Check core entries for conflicts before promotion |
| 21 | `22-emotion-arcs.md` | §8k Emotional Arcs | Build per-topic emotional trajectory (↑↓↕→) |
| 22 | `23-memory-aging.md` | §8l Memory Aging | Three-tier aging: NULL original/English past TTL, pressure-based |
| 23 | `24-entity-review.md` | §8m Entity Review | Fix ABM-L @reference anomalies, re-compress |

### Garbage Collection (§4)

Dreamy scans all messages in the DB and cleans up noise while preserving emotional signals.

**Step 1 — Purge expired garbage:** Read `garbage.json`, delete messages marked >7 days ago.

**Step 2 — Immediate deletes (no grace period):**
- Duplicates: same content, same chat, within 5 minutes → keep first, delete rest
- Wrong-chat messages → delete message + the one before it + both responses
- Whisper/STT garbage: garbled transcriptions

**Step 3 — Repeated probes:** Same question 3+ times → keep first + response, mark rest as garbage.

**Step 4 — Noise marking (7-day grace period):** Greetings, pings, filler → `garbage.json`. Does NOT mark action confirmations, instructions, or questions with content.

**Step 4a — Daily summary (code-driven):** Reads messages from DB, batches by token budget (40% of `AGENT_SLEEP_CTX_WINDOW`), accumulates summary across batches. Strips media payloads (base64, binary). Three-level escalation: normal → aggressive → deterministic fallback. Writes `daily/daily_YYYYMMDD.md`.

**Step 4b — Extract from daily (code-driven):** Reads daily summary file, sends to model with extraction prompt. Model calls `agentbridge-store` for each memory. Clean input (no SQL tool calls needed).

**Step 5 — GC noise:** Marks small talk/noise messages as garbage (flushed after 12h).

**Extraction watermark:** Tracks last processed timestamp per chat in `extraction_watermarks` table. Only advanced when all steps succeed (`dreamySucceeded` gate) — NOT on partial completion, NOT on instant-store. If essential steps fail, the watermark stays put so catch-up can re-read those messages. This ensures Dreamy re-scans all messages since last successful sleep, even if the main agent stored some during conversation.

**Proactive storing (SOUL):** The main agent stores memories during conversation — facts, decisions, preferences, events. Dreamy is the safety net for anything missed. "If in doubt, store it" — deduplication happens during sleep.

**Step 6 — Emotion harvest (verbal only):** Update nearest memory's `emotion_score` via `agentbridge-edit`. Mark emotional message as garbage.

**Step 7 — Flush old messages:** Keep max 500 messages, age out >7 days, garbage flushed after 12h. Gives Dreamy multiple nights to extract from the same messages.

### Memory Anomaly Audit (§7.5)

Daily CIA-AAA attribute health check. Auto-fixes confident cases, flags uncertain ones.

**Auto-fix:** decisions at classification=0, KP decisions at trust<2, stale credibility=6, NULL embeddings.
**Flag for review:** personal content at low classification, conflicting attributes (trust=3 + credibility≥5).

See `skills/memory-anomalies.md` for full anomaly definitions.

### Safety

- Both user AND paired assistant messages are garbage-marked/deleted together
- 7-day grace period on noise marks (dupes/wrong-chat/STT are immediate)
- `chat_backup` table is never touched — immutable audit trail
- Emotion scores are harvested before deletion — no signal loss
- Classification-aware: SECRET/CONFIDENTIAL content redacted in summaries

### Post-Sleep Wake-Up

After successful sleep, the bridge injects "You just woke up.. how did you sleep buddy?" to KP via Telegram. KP responds naturally, referencing the sleep audit, retro, and any flagged items.

### Key Files

| File | Purpose |
|------|---------|
| `persona/sleep/*.md` | 15+ step prompt files (multi-turn) |
| `persona/sleeping_prompt.md` | Monolith fallback (legacy) |
| `skills/memory-anomalies.md` | Anomaly definitions for Dreamy + KP |
| `src/cli/agentbridge-sleep.ts` | CLI orchestrator: step loop, retry, skip, catch-up, watermark |
| `src/components/sleep-prompt-loader.ts` | Load step files + variable substitution |
| `src/components/sleep-trigger.ts` | `hasSleepAuditToday()` — checks if sleep already ran today |
| `src/components/sleep-state-gatherer.ts` | Collects system state for identity prompt |
| `src/components/sleep-daily-summary.ts` | Code-driven batched summarization (04a) |
| `src/components/sleep-extract-daily.ts` | Code-driven extraction from daily file (04b) |
| `src/memory/media-sanitizer.ts` | Strips base64/binary/media paths from messages |
| `~/.agentbridge/memory/garbage.json` | GC tracking |
| `~/.agentbridge/memory/sleep/` | Audit logs (`.md`) + state files (`.lock`) |
| `~/.agentbridge/memory/daily/` | Daily summary files (`daily_YYYY-MM-DD.md`) |
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
[Agent proactively stores memories via agentbridge-store → extracted_memories (SOUL: "if in doubt, store it")]
[instant-store skill removed — storing instructions now in SOUL Continuity section]
    │
    ▼
[Reaction arrives → messages.emotion_score updated → propagated to extracted_memory via editMemory]
    │
    ▼
[Sleep cycle]
    │
    ├── §1: Retrospective reads full messages (raw + emotion_score)
    ├── §2: Feedback pass — boost/demote recalled memories
    ├── §4a: Daily summary (code-driven, accumulating batches → daily file)
    ├── §4b: Extract from daily → facts move to extracted_memories
    ├── §4c: GC — noise marking, garbage flush 12h, age 7d, cap 500
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

All memory components live in `src/memory/` (moved from `src/components/` during refactor).

| Component | File | Description |
|-----------|------|-------------|
| MemoryManager | `memory-manager.ts` | Top-level coordinator. Owns SQLite DB, delegates to sub-services. Search, stats, core knowledge. |
| MessageStore | `message-store.ts` | Message recording, loading, emotion score updates. Dashboard queries (getAllExtractedMemories, getAllEntities, getDistinctChatIds). |
| MemoryEditor | `memory-editor.ts` | Extracted memory mutations: editMemory(), instantStore(), merge, reclassify, cascadeDelete. |
| MaintenanceService | `maintenance-service.ts` | Disk budget, backup pruning, auto-compact, forget operations. |
| MemoryBackend | `memory-backend.ts` | Abstract interface for memory storage (store, edit, recall, delete, merge). |
| SqliteBackend | `sqlite-backend.ts` | Default MemoryBackend wrapping MemoryManager. |
| BackendFactory | `backend-factory.ts` | `createMemoryBackend()` — tries IPC socket first, falls back to SQLite. |
| MemoryIpcServer | `memory-ipc-server.ts` | Unix socket server (`~/.agentbridge/memory.sock`). Keeps DB open for CLI tools. |
| MemoryIpcClient | `memory-ipc-client.ts` | IPC client implementing MemoryBackend over Unix socket. |
| MemoryIndex | `memory-index.ts` | FTS5 search + Darwinism recall counting. Emoji-stripped at index level. |
| memory-db | `memory-db.ts` | Schema creation, numbered migrations with `schema_version` table, FTS5 triggers, custom SQL functions (strip_emojis, strip_diacritics). |
| memory-config | `memory-config.ts` | Env var loading + defaults for all memory settings. |
| ollama-embed | `ollama-embed.ts` | Embedding via ollama API: embedText(), vectorSearch() (capped at 500 recent), batch embed. |
| recall-engine | `recall-engine.ts` | 4-stage pipeline (Sf + Ss + Se + S6), priority ordering, MMR post-processing. |
| trigram-search | `trigram-search.ts` | Sf stage: porter FTS5 + trigram (content_en + content_original) with z↔y swap and substring fallback. |
| consolidation-search | `consolidation-search.ts` | Search daily/weekly/quarterly .md consolidation files on disk. |
| mmr | `mmr.ts` | Maximal Marginal Relevance re-ranking (λ=0.7) for recall post-processing. |
| emotion-utils | `emotion-utils.ts` | `clampEmotionScore()` — clamps to -5..+5 range. |
| SessionContext | `session-context.ts` | `buildSessionStartContext()` — session-start context injection. |
| PromptScanner | `prompt-scanner.ts` (in `src/components/`) | 22-pattern prompt injection detector. Used by store, edit, A2A. |
| SleepTrigger | `sleep-trigger.ts` (in `src/capabilities/sleep/`) | `hasSleepAuditToday()` — guard against re-run. |
| SleepStateGatherer | `sleep-state-gatherer.ts` (in `src/capabilities/sleep/`) | Gathers DB stats, FTS5 health, disk usage for sleep prompt. Takes MemoryManager. |
| agentbridge-recall | `cli/agentbridge-recall.ts` | CLI wrapper for recall-engine. Uses `createMemoryBackend()` (IPC or SQLite). |
| agentbridge-store | `cli/agentbridge-store.ts` | Instant memory storage. Boost/demote/reclassify/merge/delete. Uses `createMemoryBackend()` (IPC or SQLite). |
| agentbridge-edit | `cli/agentbridge-edit.ts` | Unified memory mutation. Edit by `--memory-id` or `--message-id`. Classification guards, dry-run. Uses `createMemoryBackend()` (IPC or SQLite). |
| agentbridge-sleep | `cli/agentbridge-sleep.ts` | Sleep cycle orchestrator. Multi-turn conversation with Dreamy. |
| agentbridge-embed | `cli/agentbridge-embed.ts` | Batch embed all memories with NULL embedding via ollama. |
| agentbridge-skill | `cli/agentbridge-skill.ts` | Auto-skill management. create/edit/patch/delete/list in `~/.agentbridge/skills/auto/`. Security scan on writes. |
| agentbridge-backfill-v2 | `cli/agentbridge-backfill-v2.ts` | One-time migration: fills emotion_tags, importance_flags, content_compressed (ABM-L), signature on all existing memories. No LLM, pure regex. |

### ABM v2 Store-Time Pipeline

Every `agentbridge-store` call runs these enrichments (~1-5ms total, no LLM):

| Module | Output column | What |
|---|---|---|
| `emotion-tagger.ts` | `emotion_tags` | 25 emotion types via keyword regex (joy, fear, conviction, etc.) |
| `importance-flagger.ts` | `importance_flags` | 8 flag types (decision, pivot, origin, milestone, etc.) |
| `memory-compressor.ts` | `content_compressed` | ABM-L format: `[FLAGS\|topic\|emotion\|confidence\|date] @entity content` |
| `signature-generator.ts` | `signature` | 256-bit binary hash via Random Indexing for Hamming distance search |

### ABM-L (Memory Language)

Compressed symbolic format for LLM consumption. See `docs/specs/abm-language.md`.

```
[D|coding|convict|5|2026-01] @clerk >over @auth0 (pricing+DX)
[P|personal|—|4|2026-03] @user prefers dark-mode+vim+minimal-code
[LT|coding|frust|4|2026-03] FTS5 breaks on HU — EN for search
```

Flags: D=decision, P=preference, F=fact, L=lesson, O=origin, V=pivot, M=milestone, C=correction, T=technical, B=core belief. @references for entities. >over, >replaces, → for relationships.

### Search Modes (`memory.env`)

| Mode | How | Needs ollama |
|---|---|---|
| `hybrid` (default) | Signatures pre-filter → embedding rerank | Yes |
| `embedding` | Ollama embeddings only (legacy) | Yes |
| `signature` | Binary signatures + Hamming distance | No |

Search stages: Sf (porter FTS5 + trigram with z↔y and substring fallback), Se (embedding cosine), Ss (signature Hamming, cap 5, threshold 0.65), S6 (consolidation files). Sf always runs. Ss and Se skipped if Sf fills the limit. S6 always runs (different data source).

### Two-Tier Aging

| Tier | Column | Base TTL | Protected by |
|---|---|---|---|
| English | `content_en` | Never (preserved for trigram search) | — |
| Original | `content_original` | 90 days | Flashbulb (\|emotion\| ≥ 4 + pivot/correction) |
| float32 embedding | `memory_embeddings` | 14 days (quantized to int8) | — |
| int8 embedding | `memory_embeddings` | Never | — |
| ABM-L | `content_compressed` | Never | — |
| Signature | `signature` | Never | — |

Pressure-based acceleration: aging TTLs multiply by pressure factor as DB approaches `MEMORY_MAX_DB_SIZE_MB` (0-50%: 1×, 50-75%: 0.7×, 75-90%: 0.35×, 90-95%: 0.15×, 95%+: immediate).

### Brain Patterns

| Pattern | Module | What | Wired |
|---|---|---|---|
| Emotional recall boost | `recall-engine.ts` (Sa + Ss stages) | Score weighted by \|emotion_score\| — `1 + 0.02 × \|emotion\|` | ✅ Applied in Sa and Ss scoring |
| Flashbulb protection | `brain-patterns.ts` → `memory-manager.ts` | \|emotion\| ≥ 4 + pivot/correction → never aged/decayed | ✅ Called by `ageMemoryTiers()` |
| Aging protection | `brain-patterns.ts` → `memory-manager.ts` | \|emotion\| ≥ 4 OR recall ≥ 3 OR core tier → skip aging | ✅ Called by `ageMemoryTiers()` |
| Spaced repetition decay | `brain-patterns.ts` → `memory-manager.ts` | `effectiveConfidence()` — confidence decays unless recalled at intervals | ✅ Wired: `computeDecayedConfidence()` writes candidates to `darwinism-candidates.json` during sleep pre-tasks |
| Interference detection | `brain-patterns.ts` | `detectInterference()` — flag similar-but-different memories in same topic | ⚠️ Exported, tested, NOT called at runtime |

### Session Start (Wake-Up Builder)

`wake-up-builder.ts` + `wake-up-renderer.ts` build memory context for session start. Budget: 1% of `CONTEXT_WINDOW_SIZE`.

Priority fill: core memories → latest daily → 7 dailies → weekly → quarterly. All ABM-L.

Adaptive compression levels:
- `full` (>5K tokens): raw ABM-L, no tricks
- `compact` (>500 tokens): entity header (2-letter codes for 3+ refs), topic grouping, elide default confidence/neutral emotion
- `ultra` (<500 tokens): all of compact + compressed SOUL (rules only, ~100 tokens)

Daily summaries compressed via `compressDailySummary()` (markdown → ABM-L bullets, 5× compression). SOUL compressed via `compressSoul()` for ultra mode (20× compression).

### Embedding Tiering

Separate `memory_embeddings` table (migration v9). float32 quantized to int8 after 14 days via `embedding-quantize.ts`. int8 (384 bytes) kept forever. `cosineSimInt8()` for similarity search on quantized vectors.

### Bedtime Flow

```
BED_TIME passes → quiet tick counter starts
  Any message → counter resets to 0
  Tick N-1 → agent announces sleep to user (system message)
  Tick N → Dreamy spawns directly (no bridge restart)
  Dreamy completes → pmset sleepnow (if MAC_SLEEP_AFTER_DREAMY=true)
  Mac wakes → watchdog detects stale heartbeat → exit(1) → LaunchAgent restarts
```

Config: `BED_TIME` (default 2:00), `BED_QUIET_TICKS` (default 6 = 30min), `MAC_SLEEP_AFTER_DREAMY` (default false).

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_ENABLED` | `true` | Enable/disable memory system |
| `MEMORY_DIR` | `~/.agentbridge/memory` | Memory storage directory |
| `EMBEDDING_ENABLED` | `true` | Enable ollama vector embeddings (Se sidecar) |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `EMBEDDING_URL` | `http://localhost:11434` | Ollama API endpoint |
| `EMBEDDING_SIMILARITY_THRESHOLD` | `0.5` | Cosine similarity threshold for Se sidecar |
| `DEBUG_MODE` | `false` | Enables chat_backup writes |
| `MEMORY_RECALL_SHORT_CIRCUIT` | `true` | Toggle short-circuit in recall cascade |
| `MEMORY_DISK_BUDGET_MB` | `500` | Disk budget for memory directory |
| `MEMORY_FORGET_THRESHOLD` | `0.8` | Relevance threshold for topic-based forgetting |
| `MEMORY_BACKEND` | `sqlite` | Memory backend type (only `sqlite` currently) |
| `MEMORY_IPC` | `1` | Set to `0` to disable IPC socket (CLI tools open own DB) |
| `AGENT_BRIDGE_HOME` | `~/.agentbridge` | Base directory for all runtime data (env override for paths) |

---

## File System Layout

```
~/.agentbridge/memory/
  memory.db                    # SQLite: messages (hot buffer) + extracted_memories (permanent)
  memory.sock                    # Unix socket for CLI IPC (bridge keeps DB open)
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

~902 tests across 90 files.

### Test Categories

| Category | Files | Tests | What they cover |
|----------|-------|-------|-----------------|
| Unit tests | ~65 files | ~750 | Individual components: FTS5 indexing, emotion utils, MMR, config parsing, formatters, security gate, session manager, ABM v2 batch A-E, etc. |
| Property-based tests | 8 files | ~40 | Invariant verification with randomized inputs: browser IPC, domain allowlist, content extractor, web scraper, browser tool. |
| Integration tests | 2 files | ~17 | Multi-component flows with real SQLite: memory lifecycle (record→search→restore→context), recall pipeline S1-S7+Se+Sa+Ss. |
| CLI tests | 6 files | ~35 | Arg parsing + validation for agentbridge-store, recall, cron, todo, browse, expand. |

### Recall Pipeline Integration (`recall-integration.test.ts`)

8 tests covering the recall pipeline with a real SQLite DB:
- Sf: Porter FTS5 (keyword match), trigram (preserved_keyword, content_original fallback), classification filter
- S6: Consolidation file search
- Full pipeline: merged results, deduplication, empty on zero results (no S7 fallback)
- Se: Semantic embedding search (optional — requires ollama, skips if unavailable)

### Optional Tests

Se (embedding) tests require a running ollama instance with `nomic-embed-text`. They gracefully skip when ollama is unavailable — CI runs without them, local dev includes them.

---

## Schema-Only Columns (Not Yet Wired)

Columns that exist in the DB schema (via migrations) but have no code reading or writing them at runtime.

| Column | Migration | Intended purpose | What's missing |
|---|---|---|---|
| `source_type` | v8 (default `'conversation'`) | Track memory origin: conversation/observation/correction/external/inference | `instantStore()` doesn't set it. No `--source-type` CLI flag. Default value written by SQLite on INSERT. Reserved for future trust model. |
| `emotion_arc` | v8 | Per-topic emotional trajectory (↑↓↕→) | Not populated by any sleep step. `buildArc()` exists but not wired. Will be wired with sleep simplification (item #4). |

---

## Not Yet Implemented

Features described in specs (`docs/specs/abm-*.md`) that have no implementation in source.

| Feature | Spec | Status |
|---|---|---|
| Semantic network activation (E7) | `abm-brain-patterns.md` | No code. Real-time spreading activation across linked topics during recall. |
| Prospective memory (E5) | `abm-brain-patterns.md` | No code. Wake-up builder doesn't check for future `valid_from` dates. |
| Multi-resolution recall (signal/compact) | `abm-competitive-analysis.md` | `resolution` param exists on `RecallParams` but only `"full"` vs default (ABM-L) is differentiated. `"signal"` and `"compact"` modes fall through to same ABM-L output. |
| Hardware profiles | `abm-competitive-analysis.md` | No `MEMORY_PROFILE` config. No profile-based pipeline adaptation (server/desktop/mobile/edge). |
| Self-improving compression | `abm-competitive-analysis.md` | No entity relationship stability tracking. No correction feedback loop into compressor. |
| Phase 3: Universal Access | `abm-roadmap.md` | No unified `agentbridge-memory` CLI, no MCP server, no OpenClaw plugin. |
