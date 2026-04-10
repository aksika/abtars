# ABM Simplification — Master Plan

**Date:** 2026-04-08
**Status:** 5 of 7 items done. #2 planned, #3 and #5 parked.

---

## Overview

Full-system review after verifying as-built against specs and source code. The system is genuinely sophisticated — more so than any open-source memory system in the competitive analysis. But it's over-designed in places. This document is the index; each item has its own detailed plan in a numbered companion doc.

**Approach:** Work through items 1-by-1, finding common ground. Each simplification is validated against the recall benchmark before and after. No changes without measurement.

**Test harness:** `src/memory/recall-benchmark.ts` — 42 queries, per-stage hit tracking, golden set support for P@10/R@10/MRR.

---

## Items

### 1. Recall Pipeline: 10 Stages → 4 Stages ✅

10 stages grew organically with heavy overlap. 4 keyword stages (S1, S2, S3, Sa) do the same job. Despite 10 stages, a simple Hungarian typo defeats the entire pipeline.

**Solution:** Sf (porter FTS5 + trigram on content_en/keyword + trigram on content_original) + Ss (signature Hamming) + Se (embedding, optional) + S6 (consolidation grep). Typo tolerance via trigrams. Diacritics-stripped. Porter stemming retained. MMR reranking. Short-circuit when Sf fills limit.

**Side effect:** Content_en preserved forever (no aging). This resolved the main pain point of #2.

**Detail:** `1-abm-simplification-plan.md`
**Evidence:** `1-abm-simplification-evidence.md`, `1-abm-simplification-baseline.json`
**Decision:** ✅ Implemented (2026-04-09)

---

### 2. ABM-L as Render Layer + Memory Timelines — REOPENED

**Original:** Store English, compress on read. Closed as resolved by #1.

**Reopened with new framing:** ABM-L's value is context window efficiency at read time, not storage savings. Compress on read (not store) eliminates backfill steps, entity review, and compression bugs. Plus: memory timelines group related memories into narrative arcs — 4 memories become 1 timeline entry. Timelines also enable smarter deduplication (group → compare within group, not all pairs).

Three rendering levels, all from stored English:
- L0 signal (3 tokens) → L1 ABM-L (10 tokens) → L2 timeline (5 tokens/memory) → L3 English (50 tokens)
- Wake-up builder picks level based on context budget + model capability

**Detail:** `2-abm-simplification-render-layer.md`
**Decision:** ⏳ Planned — 8 tasks, ~7hr. Depends on #7 (buildArc wiring).

---

### 3. CIA-AAA → Simpler Security Model — PARKED

Four security dimensions (classification 0-3, trust 0-3, integrity 0-3, credibility 1-6) for a single-user system.

**Assessment:** Already built and tested. Doesn't cause bugs or performance issues. Migration + rewriting every store/edit/recall path has low ROI. Leave unless actively blocking something. CIA-AAA enables future multi-agent (A2A) trust gating which has real value.

**Decision:** 🅿️ Parked — no action unless actively blocking

---

### 4. Sleep: 24 Steps → 4 Phases 🔜

24 prompt files, context accumulates across steps. Token cost explodes by step 20. Identity prompt alone took 21 minutes on deepseek.

**Solution:** Four phases with fresh sessions. Code-driven maintenance between phases (zero LLM cost). SLEEP_QUALITY tiering (budget/normal/ultimate). Professor reviews audit as "dream report" with flagged issues. Bug fixes ship immediately (retro watermark, garbage filter, telemetry).

**Key additions since initial proposal:**
- Phase 1 reordered: GC first → daily summary → retro (clean, watermark-scoped)
- 6 code-driven steps extracted from LLM conversation (free)
- Phase 2 batched: 14 prompts → 2-3 focused prompts (10-15 memories each)
- Phase 4: Professor sends "dream report" with flagged issues, 5-min window before hardware sleep (gated on `HARDWARE_SLEEP_AFTER_DREAMY`)
- SLEEP_QUALITY tiering: budget (3 calls), normal (6+3 weekly), ultimate (9-13)
- Sleep telemetry: log contextPercent per step before refactoring
- Prompt file disposition: 4 kept, 14 merged into 2 new, 4 kept for Phase 3, 7 replaced by code

**Detail:** `4-abm-simplification-sleep.md`
**Decision:** ⏳ Planned — ship bug fixes (0b, 0c, 0d) immediately, phase refactor after #7

---

### 5. Drop IPC Layer — PARKED

Unix socket IPC exists because bridge holds DB open and CLIs need access.

**Assessment:** IPC solves a real problem — concurrent writes from CLI tools can hit SQLITE_BUSY. WAL handles reads but not concurrent writes reliably. The IPC code isn't causing maintenance pain. Keep unless it becomes a problem.

**Decision:** 🅿️ Parked — no action unless causing maintenance pain

---

### 6. No Speculative Schema ✅

Dead columns and functions — schema ran ahead of code.

**Solution:** Drop 2 dead columns (`last_recall_context`, `related_topics`). Wire `effectiveConfidence()` into Darwinism as code-driven pre-pass. Keep `detectInterference()` and `buildArc()` for wiring with #1 and #4. Add "no speculative schema" steering rule.

**Detail:** `6-abm-simplification-dead-code.md`
**Decision:** ✅ Implemented (2026-04-09)

---

### 7. Emotion: Improve, Don't Drop 🔜

25 emotion types via keyword regex are already stored on every memory (~1ms, no LLM). The problem isn't the tagger — it's that nothing reads the tags. The system is half-built. Emotion is what makes the agent human-like — improve, don't simplify away.

**Solution:** Wire the existing emotion infrastructure + add emotional wake-up:
- **Emotional highlights in wake-up** — top 10 by |emotion_score| ≥ 3, after core tier
- **Emotion recall filter** — `--emotion "frustration"`
- **Wire buildArc()** — per-topic emotional trajectory in sleep
- **Cross-session emotional tone** — last session's emotions in session-start context

No other memory system does emotional trajectories across sessions.

**Detail:** `7-abm-simplification-emotion.md`
**Decision:** ⏳ Next — direction agreed, 5 tasks, ~2.5hr

---

## Backlog

Moved to main backlog (`docs/TODO/BACKLOG.md`):
- #105 Unified agent registry (High)
- #106 Bidirectional ABM-L (Low)

---

## Priority Order

| Priority | Item | Status | Effort | Rationale |
|---|---|---|---|---|
| 1 | #1 Recall pipeline | ✅ Done | ~7hr | Fixed user-facing bug, biggest simplification |
| 2 | #6 Dead schema | ✅ Done | ~1hr | Free cleanup |
| 3 | #4 bug fixes (0b, 0c, 0d) | 🔜 Ship now | ~1hr | Retro watermark, garbage filter, telemetry |
| 4 | #7 Emotion | 🔜 Next | ~2.5hr | Wire existing infrastructure, human-like quality |
| 5 | #4 Sleep phases | ⏳ Planned | ~14hr | High impact, incremental rollout |
| — | #2 ABM-L render + timelines | ⏳ Planned | ~7hr | Render on read, narrative compression, timeline dedup. After #7. |
| — | #3 CIA-AAA | 🅿️ Parked | — | Not broken, not blocking |
| — | #5 IPC layer | 🅿️ Parked | — | Solves real problem, not broken |

---

## What We Keep As-Is

- Standalone package boundary (`IMemorySystem`, zero bridge deps)
- Store-time signature generation (32 bytes, no ollama)
- Store-time ABM-L compression (working, used by wake-up + recall)
- Three-tier aging concept (sensory → narrative → essence) — but content_en no longer aged
- Flashbulb protection (pivotal moments never age)
- Wake-up builder budget-based greedy fill (1% context window)
- Memory Darwinism (recall-count boosting, self-organizing)
- Dreamy concept (overnight maintenance agent)
- CIA-AAA security model (working, enables A2A trust gating)
- IPC layer (solves concurrent write problem)

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
| Token cost | contextPercent per step (telemetry task 0d) |
| Completion rate | % of cycles that complete without timeout/failure |

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
| 1 | Recall pipeline | ✅ Implemented — 4 stages (Sf+Ss+Se+S6), porter kept, trigrams added | 2026-04-09 | `1-abm-simplification-plan.md` |
| 2 | ABM-L render layer + timelines | ✅ Implemented — column dropped, render on read, timelines, dedup | 2026-04-10 | `2-abm-simplification-render-layer.md` |
| 3 | CIA-AAA | 🅿️ Parked — not broken, not blocking | 2026-04-09 | |
| 4 | Sleep phases | ✅ Implemented — bug fixes + phase refactor + SLEEP_QUALITY tiering + HARDWARE_SLEEP rename | 2026-04-09 | `4-abm-simplification-sleep.md` |
| 5 | IPC layer | 🅿️ Parked — solves real problem | 2026-04-09 | |
| 6 | Speculative schema | ✅ Implemented — drop 2 columns, wire effectiveConfidence, keep 2 functions | 2026-04-09 | `6-abm-simplification-dead-code.md` |
| 7 | Emotion model | ✅ Implemented — unified tags, derived score, emotional wake-up, arcs, mirroring, SOUL updated | 2026-04-09 | `7-abm-simplification-emotion.md` |

---

## File Index

| File | Content |
|---|---|
| `abm-simplification.md` | This file — master plan and index |
| `1-abm-simplification-plan.md` | Item #1 detailed plan + tasks |
| `1-abm-simplification-evidence.md` | Item #1 benchmark analysis |
| `1-abm-simplification-baseline.json` | Item #1 raw benchmark data |
| `2-abm-simplification-render-layer.md` | Item #2 detailed plan + tasks |
| `4-abm-simplification-sleep.md` | Item #4 detailed plan + tasks |
| `6-abm-simplification-dead-code.md` | Item #6 detailed plan + tasks |
| `7-abm-simplification-emotion.md` | Item #7 detailed plan + tasks |
