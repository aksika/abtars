# ABM Simplification — Master Plan

**Date:** 2026-04-08
**Status:** Planning — working through items 1-by-1

---

## Overview

Full-system review after verifying as-built against specs and source code. The system is genuinely sophisticated — more so than any open-source memory system in the competitive analysis. But it's over-designed in places. This document is the index; each item has its own detailed plan in a numbered companion doc.

**Approach:** Work through items 1-by-1, finding common ground. Each simplification is validated against the recall benchmark before and after. No changes without measurement.

**Test harness:** `src/memory/recall-benchmark.ts` — 42 queries, per-stage hit tracking, golden set support for P@10/R@10/MRR.

---

## Items

### 1. Recall Pipeline: 10 Stages → 4 Stages

10 stages grew organically with heavy overlap. 4 keyword stages (S1, S2, S3, Sa) do the same job. Despite 10 stages, a simple Hungarian typo defeats the entire pipeline.

**Solution:** Sf (porter FTS5 + trigram on content_en/keyword + trigram on content_original) + Ss (signature Hamming) + Se (embedding, optional) + S6 (consolidation grep). Typo tolerance via trigrams. Diacritics-stripped. Porter stemming retained. MMR reranking. Short-circuit when Sf fills limit.

**Detail:** `1-abm-simplification-plan.md`
**Evidence:** `1-abm-simplification-evidence.md`, `1-abm-simplification-baseline.json`
**Decision:** ✅ Approved (2026-04-08) — 9 tasks, ~7hr

---

### 2. Store English, Compress on Read

ABM-L at store time bakes compression bugs into stored data. Requires two FTS5 indexes. Compressor improvements need backfill sleep steps. Custom format is hard to debug.

**Proposed:** Store English as source of truth. Compress to ABM-L at read time (wake-up, recall output). Cache compressed form optionally. Compressor improvements apply retroactively.

**Counter-argument:** Aging NULLs English — ABM-L must survive independently. But item #1 already decided: content_en preserved forever. Current store-time compression works and backfills are a one-time cost. See `abm-simplification-counter.md`.

**Detail:** _not yet created_
**Decision:** ⏳ Pending — lower priority per counter-discussion

---

### 3. CIA-AAA → Simpler Security Model

Four security dimensions (classification 0-3, trust 0-3, integrity 0-3, credibility 1-6) for a single-user system. Adds complexity to every store, edit, recall, and a dedicated sleep audit step.

**Proposed:** Two fields: `confidence` (1-5) and `sensitive` (boolean).

**Counter-argument:** Already built and tested. Migration + rewriting every store/edit/recall path has low ROI. These fields don't cause bugs or performance issues. See `abm-simplification-counter.md`.

**Detail:** _not yet created_
**Decision:** ⏳ Pending — skeptical, leave unless actively blocking

---

### 4. Sleep: 24 Steps → 4 Phases

24 prompt files, each with retry/skip logic. Context accumulates across steps. Timeout at step 12 leaves 13-24 undone with complex catch-up.

**Proposed:** Four phases, each a fresh session:
1. **Extract** — messages → memories + daily summary
2. **Curate** — dedup, merge, promote, fix, assign topics
3. **Maintain** — age, GC, disk budget, consolidate
4. **Report** — audit + flag issues

**Counter-argument:** Biggest refactor on the list. Current 24 steps are battle-tested. Do AFTER #1 is validated. See `abm-simplification-counter.md`.

**Detail:** `4-abm-simplification-sleep.md`
**Decision:** ⏳ Pending — do after #1 is stable

---

### 5. Drop IPC Layer

Unix socket IPC exists because bridge holds DB open and CLIs need access. Adds 5 files and a whole architectural layer.

**Proposed:** SQLite WAL mode + multiple readers. CLI writes use brief lock contention or file-based queue.

**Counter-argument:** Concurrent writes from CLI tools can still hit SQLITE_BUSY. IPC solves a real problem. Risky to remove. See `abm-simplification-counter.md`.

**Detail:** _not yet created_
**Decision:** ⏳ Pending — skeptical, keep unless causing maintenance pain

---

### 6. No Speculative Schema

Dead columns and functions — schema ran ahead of code. Creates false confidence, maintenance burden, and confusion.

**Solution:** Drop 2 dead columns (`last_recall_context`, `related_topics`). Wire `effectiveConfidence()` into Darwinism. Keep `detectInterference()` and `buildArc()` for wiring with items #1 and #4. Add "no speculative schema" steering rule.

**Detail:** `6-abm-simplification-dead-code.md`
**Decision:** ✅ Approved (2026-04-09) — 5 tasks, ~1hr

---

### 7. Emotion: Improve, Don't Drop

25 emotion types via keyword regex are already stored on every memory (~1ms, no LLM). The problem isn't the tagger — it's that nothing reads the tags. The system is half-built.

**Solution:** Wire the existing emotion infrastructure + add emotional wake-up. Key additions:
- **Emotional highlights in wake-up** — top 10 memories by |emotion_score| ≥ 3 loaded after core tier, before dailies. The agent starts every session knowing the stories that matter, not just the facts. Inspired by MemPalace's L1 (top 15 by emotional_weight).
- **Emotion recall filter** — `--emotion "frustration"` searches by emotional context
- **Wire buildArc()** — per-topic emotional trajectory (↑↓↕→) written by Dreamy, displayed in wake-up
- **Cross-session emotional tone** — last session's dominant emotions in session-start context

**Detail:** `7-abm-simplification-emotion.md`
**Decision:** ⏳ Pending — direction agreed (improve, not drop), tasks defined

---

## Recommended Priority Order

From `abm-simplification-counter.md`:

| Priority | Item | Rationale |
|---|---|---|
| 1 | #1 Recall pipeline | Fixes real user-facing bug, biggest simplification |
| 2 | #6 Dead schema | Free cleanup, no risk |
| 3 | #7 Emotion | Low-risk simplification |
| 4 | #4 Sleep phases | High impact but high effort — do after #1 is stable |
| 5 | #2, #3, #5 | Lower priority, valid counter-arguments exist |

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

### Recall Quality

| Metric | How to measure | Baseline source |
|---|---|---|
| Precision@10 | Of top 10 recalled memories, how many are relevant? | Manual labeling on 42 test queries |
| Recall@10 | Of all relevant memories, how many appear in top 10? | Same test set |
| MRR (Mean Reciprocal Rank) | Where does the first relevant result appear? | Same test set |
| Stage contribution | Per-stage hit rate — unique results per stage | Recall benchmark harness |

### Wake-Up Quality

| Metric | How to measure |
|---|---|
| Token count | Count tokens in wake-up context (old vs new) |
| Coverage | Of 20 "things the agent should know," how many are in wake-up? |
| Compression ratio | English tokens / ABM-L tokens for same content |

### Sleep Efficiency

| Metric | How to measure |
|---|---|
| Wall time | Total sleep cycle duration |
| Token cost | Total tokens consumed by sleep prompts + responses |
| Completion rate | % of cycles that complete without timeout/failure |

### Operational Complexity

| Metric | How to measure |
|---|---|
| Source files | Count of files in `src/memory/` |
| Lines of code | `wc -l` on memory package |
| Test count | Number of tests |
| Schema columns | Count of columns on `extracted_memories` |

### Validation workflow

1. Run recall-benchmark (baseline captured)
2. Implement simplification
3. Run recall-benchmark (compare)
4. Golden set P@10/R@10/MRR if labeled
5. Ship or revert

---

## Decision Log

| # | Item | Decision | Date | Notes |
|---|---|---|---|---|
| 1 | Recall pipeline | ✅ Approved — 4 stages (Sf+Ss+Se+S6), porter kept, trigrams added | 2026-04-08 | `1-abm-simplification-plan.md` |
| 2 | Store vs compress | ⏳ Pending — lower priority | | |
| 3 | CIA-AAA | ⏳ Pending — skeptical | | |
| 4 | Sleep phases | ⏳ Planned — incremental rollout, after #1 | 2026-04-09 | `4-abm-simplification-sleep.md` |
| 5 | IPC layer | ⏳ Pending — skeptical | | |
| 6 | Speculative schema | ✅ Approved — drop 2 columns, wire effectiveConfidence, keep 2 functions | 2026-04-09 | `6-abm-simplification-dead-code.md` |
| 7 | Emotion model | ⏳ Direction agreed — improve, not drop. Tasks defined. | 2026-04-09 | `7-abm-simplification-emotion.md` |

---

## File Index

| File | Content |
|---|---|
| `abm-simplification.md` | This file — master plan and index |
| `abm-simplification-counter.md` | Counter-discussion and priority ordering |
| `1-abm-simplification-plan.md` | Item #1 detailed plan + tasks |
| `1-abm-simplification-evidence.md` | Item #1 benchmark analysis |
| `1-abm-simplification-baseline.json` | Item #1 raw benchmark data |
| `6-abm-simplification-dead-code.md` | Item #6 detailed plan + tasks |
| `7-abm-simplification-emotion.md` | Item #7 detailed plan + tasks |
| `4-abm-simplification-sleep.md` | Item #4 detailed plan + tasks |
