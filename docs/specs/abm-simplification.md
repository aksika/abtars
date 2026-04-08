# ABM Simplification — Architectural Review

**Date:** 2026-04-08
**Status:** Planning — working through items 1-by-1

---

## Overview

Full-system review after verifying as-built against specs. The system is genuinely sophisticated — more so than any open-source memory system in the competitive analysis. But it's over-designed in places. This document captures the proposed simplifications and tracks decisions as we work through each one.

---

## 1. Recall Pipeline: 10 Stages → Unified Search

**Problem:** 10 stages (S1-S7 + Se + Sa + Ss) grew organically. Each has its own scoring, dedup, short-circuit rules. MMR reranking at the end tries to clean up the overlap.

**Proposed:** One search path with pluggable scorers.

```
Query → metadata filter (topic, tier, type, date range)
      → single scorer (signature OR embedding, configurable)
      → FTS5 boost (bonus for keyword match, not a separate stage)
      → rank + return
```

MemPalace study proved: metadata filtering gives the 34% retrieval boost. Not more stages — better filtering.

**Decision:** _pending_

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
| 1 | Recall pipeline | _pending_ | | |
| 2 | Store vs compress | _pending_ | | |
| 3 | CIA-AAA | _pending_ | | |
| 4 | Sleep phases | _pending_ | | |
| 5 | IPC layer | _pending_ | | |
| 6 | Speculative schema | _pending_ | | |
| 7 | Emotion model | _pending_ | | |
