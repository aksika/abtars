# ABM Simplification — Architectural Review

**Date:** 2026-04-08
**Status:** Planning — working through items 1-by-1

---

## Overview

Full-system review after verifying as-built against specs. The system is genuinely sophisticated — more so than any open-source memory system in the competitive analysis. But it's over-designed in places. This document captures the proposed simplifications and tracks decisions as we work through each one.

---

## 1. Recall Pipeline: 10 Stages → 4 Stages

**Problem:** 10 stages (S1-S7 + Se + Sa + Ss) grew organically. Each has its own scoring, dedup, short-circuit rules. MMR reranking at the end tries to clean up the overlap. Despite 10 stages, a simple Hungarian typo ("válókezelő" vs "váltókezelő") defeats the entire pipeline — no fuzzy matching anywhere.

**Benchmark evidence (2026-04-08, 93 memories, 42 queries):**
- S2: 1/42 queries — nearly dead (Hungarian FTS5 is broken by agglutination)
- S5: 0/42 queries — fully dead (S4 already covers message FTS5)
- S1 and Sa overlap heavily — both do FTS5 keyword matching on different representations of the same content
- S3 (LIKE) and S1 (FTS5) overlap — S3 is a broader version of S1
- Ss finds something for every query (42/42) but also returns 20 hits for "quantum computing" — too permissive

**Root cause:** 4 stages (S1, S2, S3, Sa) are all variations of "find text that matches these characters." They should be one stage.

### New pipeline

```
Query → strip_diacritics(query)
  ├── Se: fire async at start (optional, needs ollama)
  │
  ├── Sf: three-query fuzzy search
  │     1. Porter FTS5 on content_en (stemmed keyword match — deploy/deployed/deploying)
  │        Existing index, existing triggers. ~1ms.
  │     2. Trigram on content_en + preserved_keyword (fuzzy/typo/substring, diacritics-stripped)
  │        Single trigram index: strip_diacritics(content_en || ' ' || preserved_keyword)
  │     3. If results < limit: trigram on content_original (Hungarian fallback, diacritics-stripped)
  │     Each sub-query catches something the others can't. No overlap.
  │     Replaces: S1, S2, S3, Sa
  │     Includes: Darwinism scoring (recall_count + relevance_score boost)
  │     Includes: metadata filtering (topic, tier, entity, classification, includeExpired)
  │
  ├── Ss: signature Hamming (semantic approximate, no ollama)
  │     Covers: paraphrasing, synonyms, cross-language meaning
  │     Threshold 0.65, capped at 5 results (safety net, not primary search)
  │     Skipped if Sf already filled the limit (performance at scale)
  │
  ├── Se: await + merge (if fired)
  │     Covers: highest quality semantic search
  │     Optional — system works without ollama
  │     Skipped if Sf already filled the limit (performance at scale)
  │
  ├── S6: consolidation grep (always runs — different data source with proven value)
  │     180 unique hits across 30/42 queries in benchmark. Searches narrative context
  │     (daily summaries, session flow) not available in extracted_memories.
  │
  ├── Dedup: by memory ID (not content hash — same memory found by multiple stages
  │     keeps the higher-priority stage's version)
  │
  └── Final: lightweight MMR reranking (λ=0.7) on merged results.
      Prevents topic clustering — without MMR, Sf could return 8 results about
      "Mac sleep" and crowd out other relevant topics. Already built and tested.
      NO S7 — return empty on zero results.
```

### Short-circuit behavior

If Sf fills the limit (10 results), skip Ss and Se for performance. S6 always runs (different data source, fast grep). At 93 memories this doesn't matter. At 10K+ memories, Sf alone may return enough and Ss's full-table signature scan becomes expensive.

Se is already gated by ollama availability. Skipping it when Sf is full avoids a wasted ollama round-trip.

### What each stage does (no overlap)

| Stage | Method | What it catches | Data source |
|---|---|---|---|
| Sf.1 | Porter FTS5 on content_en (existing index) | Morphological variants: deploy/deployed/deploying | extracted_memories |
| Sf.2 | Trigram FTS5 on content_en + preserved_keyword (diacritics-stripped) | Typos, substrings, fuzzy matches, agent-flagged terms | extracted_memories |
| Sf.3 | Trigram FTS5 on content_original (diacritics-stripped, fallback) | Untranslated Hungarian queries, typos in original language | extracted_memories |
| Ss | Binary signature Hamming distance (cap 5, threshold 0.65) | Semantic similarity without ollama | extracted_memories.signature |
| Se | Embedding cosine similarity (ollama) | Best semantic quality | memory_embeddings |
| S6 | Substring grep on .md files | Consolidation summaries, narrative context | daily/weekly/quarterly files |

### The "válókezelő" fix

The screenshot problem: user queries in Hungarian with a typo, agent doesn't translate, all 10 stages miss.

Sf on content_original catches this: "válókezelő" and "váltókezelő" share most character trigrams (vál, óke, kez, eze, zel, elő). High trigram overlap = match despite the typo.

Priority: Sf searches content_en first (English is the search language by design). If results < limit, falls back to content_original. This handles both cases:
- Agent translates correctly → content_en trigram finds it
- Agent doesn't translate / query is Hungarian → content_original trigram finds it

### Schema changes

```sql
-- New: 2 trigram indexes (diacritics-stripped for accent-insensitive matching)
CREATE VIRTUAL TABLE content_en_trigram USING fts5(
  content, tokenize='trigram'
);
-- Populated with: strip_diacritics(content_en || ' ' || COALESCE(preserved_keyword, ''))
-- "Jörgen" indexed as "jorgen", preserved_keyword "kiskutya" searchable alongside content

CREATE VIRTUAL TABLE content_original_trigram USING fts5(
  content, tokenize='trigram'
);
-- Populated with: strip_diacritics(content_original)

-- Keep: extracted_memories_fts (porter FTS5 on content_en) — used by Sf.1
-- Drop: extracted_memories_original_fts (was S2), abml_fts (was Sa), messages_fts (was S4/S5)
```

**Diacritics handling:** Both trigram indexes store `strip_diacritics()` output. Query is also stripped before search. This makes the trigram index accent-insensitive by default — "válókezelő" query becomes "valokezelo", matches "valtokezelo" (stored from "váltókezelő") via trigram overlap.

**Aging decision (dependency on item #2):** Content_en preserved forever — no NULLing after 14 days. This eliminates the need for content_compressed (ABM-L) as a search fallback. Sf always has content_en to search. ABM-L remains for wake-up context compression only, not for search.

### Porter stemming — no regression

Porter FTS5 index (`extracted_memories_fts`) retained as Sf sub-query 1. English morphological matching preserved: "deployment" matches "deploy", "memories" matches "memory". No regression, no fallback needed.

### Ss threshold tuning

Raise threshold from 0.55 to 0.65 AND cap at 5 results. Ss is a safety net for when keyword search misses, not a primary search. Evidence: current 0.55 threshold returns 20 hits for "quantum computing" (a topic with zero relevant memories). 5 capped results is enough to catch semantic matches without flooding output with noise.

### Scoring and ranking across stages

**Priority ordering with MMR reranking.**

```
1. Sf results (keyword match — highest precision, user asked for these words)
2. Se results (embedding — highest quality semantic, if available)
3. Ss results (signature — approximate semantic, safety net, max 5)
4. S6 results (consolidation — different data source, supplementary)
```

Within each group, sort by score descending. Dedup by memory ID across groups (later group's duplicate dropped — same memory keeps the higher-priority stage's version). Then lightweight MMR (λ=0.7) on the merged list to prevent topic clustering within Sf results.

### S4/S5 (messages) disposition

**Decision: drop (option c).**

Messages are ephemeral by design — they're in the context window already. If the agent needs something from earlier today, it's either still in context or should have been extracted. Searching messages during recall blurs the line between short-term and long-term memory.

If a message was important enough to recall later, it should have been extracted (by the agent proactively or by Dreamy during sleep). The extraction watermark ensures Dreamy catches everything. Messages that weren't extracted weren't worth remembering.

Edge case: bridge restart mid-day loses context window but messages are still in DB. This is rare and the agent can re-read recent messages via session-start context injection (buildSessionStartContext), which is separate from recall.

### Upstream fix: agent recall protocol (SOUL/prompt)

The trigram fallback on content_original is a safety net. The real fix is upstream: the agent must translate queries to English before calling `agentbridge-recall --translated "..."`. The `--translated` param literally means "translated to English."

In the screenshot, the agent searched for "válókezelő" in Hungarian instead of translating to "Swedish switchman." If it had, S1 (or Sf in the new pipeline) would have found memory #24 instantly.

**Fix:** Add explicit instruction to SOUL.md / TOOLS.md recall section:

```
When recalling: ALWAYS translate the user's query to English keywords before calling
agentbridge-recall --translated. The --translated parameter means "translated to English."
Never pass Hungarian/original-language words as --translated. Use --original for the
original-language keyword as a secondary search signal.
```

This is a prompt fix, not a code fix. The recall engine already supports the correct workflow — the agent just needs to follow it.

**Task:** Add to implementation list as task 0 (no code dependency, can ship immediately).

### Implementation tasks

| # | Task | Effort | Depends on |
|---|---|---|---|
| 0 | SOUL/prompt fix: add explicit "always translate to English before recall" instruction to TOOLS.md recall section | 15min | — |
| 1a | Schema migration: create 2 new trigram FTS5 tables (`content_en_trigram`, `content_original_trigram`), populate with `strip_diacritics()` output. content_en_trigram includes preserved_keyword. Add INSERT/UPDATE/DELETE triggers with `strip_diacritics()`. Keep existing `extracted_memories_fts` (porter). | 1hr | — |
| 1b | Disable content_en aging: update `ageMemoryTiers()` to skip NULLing content_en. Content_en preserved forever. Prerequisite for dropping Sa. | 30min | — |
| 2 | `trigram-search.ts` — Sf stage: three sub-queries (porter FTS5, trigram content_en, trigram content_original fallback). strip_diacritics(query) for trigram queries. Darwinism scoring. Metadata filtering (topic, tier, entity, classification, includeExpired). | 1.5hr | 1a |
| 3 | Rewire `recall-engine.ts` — new pipeline: Se fire async → Sf → Ss (skip if Sf full) → Se await+merge (skip if Sf full) → S6 (unconditional). Dedup by memory ID. MMR reranking (λ=0.7). Ss threshold 0.65, cap 5. Drop S1-S5, S7, Sa. | 2hr | 2 |
| 4 | Update `agentbridge-recall` CLI — remove `--stages` options for dead stages, keep `--full` for resolution | 30min | 3 |
| 5 | Run recall-benchmark, compare against baseline (`1-abm-simplification-baseline.json`) | 30min | 4 |
| 6 | Test válókezelő case: query "válókezelő" against content_original trigram, verify match to memory #24 | 15min | 5 |
| 7 | Drop old FTS5 tables + triggers in migration: `extracted_memories_original_fts`, `abml_fts`, `messages_fts` (NOT `extracted_memories_fts` — kept for porter) | 30min | 5 |
| 8 | Update as-built doc (`memory.asbuilt.md`) — new pipeline, new stages, removed stages, aging change | 30min | 7 |

**Total: ~7hr**

Branch: `simplify/recall-pipeline`

**Decision:** Approved (2026-04-08)

---

## 2. Store English, Compress on Read

**Problem:** ABM-L at store time bakes compression bugs into stored data. Requires two FTS5 indexes (English + ABM-L). Compressor improvements need backfill steps. Custom format is hard to debug.

**Proposed:** Store English as source of truth. Compress to ABM-L at read time (wake-up, recall output). Cache compressed form optionally. One FTS5 index. Compressor improvements apply retroactively.

**Counter-argument:** Aging NULLs English — ABM-L must survive independently. But: could keep a one-sentence English summary instead of NULLing entirely, or just keep English longer (local SQLite storage is cheap).

**Decision:** _pending_

---

## 3. CIA-AAA → Simpler Security Model

**Problem:** Four security dimensions (classification 0-3, trust 0-3, integrity 0-3, credibility 1-6) for a single-user system. Adds complexity to every store, edit, recall, and a dedicated sleep audit step.

**Proposed:** Two fields: `confidence` (1-5, combines trust + credibility + integrity) and `sensitive` (boolean, don't leak in group contexts).

**Counter-argument:** CIA-AAA enables future multi-agent (A2A) trust gating. Trust=0 (web) vs trust=3 (owner) is meaningful when peers send memories.

**Decision:** _pending_

---

## 4. Sleep: 24 Steps → 4 Phases

**Problem:** 24 prompt files, each with retry/skip logic. Context accumulates across steps (step 20 sees steps 1-19). Timeout at step 12 leaves 13-24 undone with complex catch-up.

**Proposed:** Four phases, each a fresh session:
1. **Extract** — messages → memories + daily summary
2. **Curate** — dedup, merge, promote, fix, assign topics
3. **Maintain** — age, GC, disk budget, consolidate
4. **Report** — audit + flag issues

**Decision:** _pending_

---

## 5. Drop IPC Layer

**Problem:** Unix socket IPC exists because bridge holds DB open and CLIs need access. Adds 5 files and a whole architectural layer (server, client, backend interface, factory, sqlite-backend).

**Proposed:** SQLite WAL mode + multiple readers. CLI writes use brief lock contention or file-based queue.

**Counter-argument:** IPC gives atomic request/response semantics and avoids SQLite busy-timeout edge cases under concurrent writes.

**Decision:** _pending_

---

## 6. No Speculative Schema

**Problem:** Three columns (`source_type`, `last_recall_context`, `related_topics`) exist but nothing reads/writes them. Two brain-pattern functions exported+tested but never called. Spec-driven development where schema ran ahead of code.

**Proposed:** Principle: don't add a column until you have the code that writes it AND reads it AND a test proving the round-trip. Remove dead columns via migration.

**Decision:** _pending_

---

## 7. Emotion: 25 Types → Single Score

**Problem:** 25 emotion types via keyword regex + separate emotion_score integer + emotion_arc per topic + emotional recall boost. MemPalace benchmark showed raw ChromaDB (no emotion) scores 96.6%. The 34% boost came from topic filtering, not emotion.

**Proposed:** Keep `emotion_score` (-5 to +5, LLM-assigned). Drop 25-type tagger. Use emotion for one thing: flashbulb protection. Don't use for recall ranking — frustrated debugging shouldn't outrank calm architectural decisions.

**Counter-argument:** Emotion tags are cheap (~1ms) and provide structured data for arc building. The tagger is already shipped and tested.

**Decision:** _pending_

---

## What We Keep As-Is

- Standalone package boundary (`IMemorySystem`, zero bridge deps)
- Store-time signature generation (32 bytes, no ollama)
- Three-tier aging concept (sensory → narrative → essence)
- Flashbulb protection (pivotal moments never age)
- Wake-up builder budget-based greedy fill (1% context window)
- Memory Darwinism (recall-count boosting, self-organizing)
- Dreamy concept (overnight maintenance agent)

---

## Efficacy Comparison Framework

To validate simplifications don't regress quality, we need before/after measurement.

### Recall Quality

| Metric | How to measure | Baseline source |
|---|---|---|
| Precision@10 | Of top 10 recalled memories for a query, how many are relevant? | Manual labeling on 50 test queries against current system |
| Recall@10 | Of all relevant memories, how many appear in top 10? | Same test set |
| MRR (Mean Reciprocal Rank) | Where does the first relevant result appear? | Same test set |
| Stage contribution | Per-stage hit rate — which stages actually find unique results? | Recall engine already logs per-stage hits and timing |

**Method:** Build a test harness that runs the same 50 queries against old pipeline and new pipeline, compares results. The recall engine already returns `stages` with per-stage hits — we can measure which stages contribute unique results vs duplicates.

### Wake-Up Quality

| Metric | How to measure |
|---|---|
| Token count | Count tokens in wake-up context (old vs new) |
| Coverage | Of 20 "things the agent should know," how many are in wake-up? |
| Compression ratio | English tokens / ABM-L tokens for same content |

**Method:** Snapshot current wake-up output. After changes, compare coverage and token count.

### Sleep Efficiency

| Metric | How to measure |
|---|---|
| Wall time | Total sleep cycle duration (old 24-step vs new 4-phase) |
| Token cost | Total tokens consumed by sleep prompts + responses |
| Completion rate | % of cycles that complete without timeout/failure |
| Extraction quality | Memories extracted per daily summary (count + relevance) |

**Method:** Sleep audit logs already capture per-step timing and success/failure. Compare aggregates.

### Operational Complexity

| Metric | How to measure |
|---|---|
| Source files | Count of files in `src/memory/` |
| Lines of code | `wc -l` on memory package |
| Test count | Number of tests (should stay stable or decrease proportionally) |
| Schema columns | Count of columns on `extracted_memories` |
| Config surface | Number of env vars in `memory.env` + bridge `.env` |

### Test Harness Plan

1. **Snapshot current state:** dump 50 recall queries + results + per-stage breakdown
2. **Build golden set:** manually label top-10 relevance for each query (binary: relevant/not)
3. **Automate comparison:** script that runs queries against both old and new, computes P@10, R@10, MRR
4. **Run after each simplification item** — catch regressions immediately

The golden set is the key investment. Once we have labeled queries, every future change can be validated in seconds.

---

## Decision Log

| # | Item | Decision | Date | Notes |
|---|---|---|---|---|
| 1 | Recall pipeline | Approved — 4 stages (Sf+Ss+Se+S6), porter kept, trigrams added | 2026-04-08 | See item 1 detail |
| 2 | Store vs compress | _pending_ | | |
| 3 | CIA-AAA | _pending_ | | |
| 4 | Sleep phases | _pending_ | | |
| 5 | IPC layer | _pending_ | | |
| 6 | Speculative schema | Approved — drop 2 columns, remove 2 dead functions, keep 2 columns reserved | 2026-04-09 | See `6-abm-simplification-dead-code.md` |
| 7 | Emotion model | _pending_ | | |
