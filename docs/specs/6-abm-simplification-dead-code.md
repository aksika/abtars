# ABM Simplification #6 — No Speculative Schema

**Date:** 2026-04-09
**Status:** Planning
**Companion to:** `1-abm-simplification-plan.md`

---

## Problem

Schema and code ran ahead of implementation. Columns exist with no readers/writers. Functions are exported and tested but never called at runtime. This creates:
- False confidence: the as-built documents features that don't actually work
- Maintenance burden: migrations, types, and tests for dead code
- Confusion: future developers (or the agent itself) assume these features are live

## Inventory of Dead Code

### Dead columns (exist in schema, never meaningfully written or read)

| Column | Migration | Default | Rows with non-default value | Written by | Read by |
|---|---|---|---|---|---|
| `source_type` | v8 | `'conversation'` | 0/93 (all have default) | Nothing — SQLite DEFAULT on INSERT | `nlm-command-handler.ts` (unrelated NLM context, not memory recall) |
| `last_recall_context` | v8 | NULL | 0/93 | Nothing | Nothing |
| `related_topics` | v8 | NULL | 0/93 | Nothing | Nothing |
| `emotion_arc` | v8 | NULL | 0/93 | Nothing | `wake-up-builder.ts` reads it, always gets NULL |

### Dead functions (exported, tested, never called at runtime)

| Function | File | Tests | Called by runtime code |
|---|---|---|---|
| `effectiveConfidence()` | `brain-patterns.ts` | `abm-v2-batch-e.test.ts` (5 assertions) | No — not used by recall-engine, Darwinism, or any sleep step |
| `detectInterference()` | `brain-patterns.ts` | `abm-v2-batch-e.test.ts` (4 assertions) | No — not used by recall-engine or any sleep step |
| `buildArc()` | `emotion-arc.ts` | `abm-v2-batch-c.test.ts` (3 tests) | No — not used by any sleep step. `emotion_arc` column is never populated. |

### Live functions in same file (must NOT remove)

| Function | File | Called by |
|---|---|---|
| `isFlashbulb()` | `brain-patterns.ts` | `ageMemoryTiers()` in `memory-manager.ts` |
| `isAgingProtected()` | `brain-patterns.ts` | `ageMemoryTiers()` in `memory-manager.ts` |

---

## Decisions

### Columns: remove or keep?

**Option A: Remove via migration.** `ALTER TABLE ... DROP COLUMN` (SQLite 3.35+). Clean schema, no dead weight.

**Option B: Keep columns, document as reserved.** Zero cost (NULL columns don't consume space in SQLite). Available if we implement the features later without a migration.

**Recommendation: Option B for `source_type` and `emotion_arc`. Option A for `last_recall_context` and `related_topics`.**

Reasoning:
- `source_type` has a clear future use (item #3 CIA-AAA simplification may repurpose it as a trust signal). Already has a sensible default. Keep.
- `emotion_arc` is read by wake-up-builder (just gets NULL). If we implement arc building in sleep, the column is ready. Keep, but fix wake-up-builder to skip NULL arcs cleanly.
- `last_recall_context` was for reconsolidation (E4 brain pattern). No clear path to implementation. Remove.
- `related_topics` was for cross-topic linking (C7). No clear path to implementation. Remove.

### Functions: wire or keep?

**Wire `effectiveConfidence()` into Darwinism sleep step.** ~10 lines of integration. Memories that haven't been recalled in months decay in confidence, making them candidates for pruning. Self-organizing memory. Clear value, trivial effort.

**Keep `detectInterference()` — wire with recall pipeline simplification (item #1).** Runs on recall result set (max 10 results, 45 pair comparisons — negligible). Flags similar-but-different memories in the same topic so the agent can clarify. Needs a warning field in recall output. Medium effort, best done alongside the recall pipeline rewrite.

**Keep `buildArc()` — wire with sleep simplification (item #4).** Sleep step calls `buildArc()` per topic, writes result to `emotion_arc` column. Wake-up builder already reads it (currently gets NULL). Best done when sleep steps are reorganized into phases.

### Principle going forward

**No speculative schema.** Don't add a column until:
1. Code exists that writes it
2. Code exists that reads it
3. A test proves the round-trip

Add this as a steering rule in `.kiro/steering/`.

---

## Implementation Tasks

| # | Task | Effort | Depends on |
|---|---|---|---|
| 1 | Migration: drop `last_recall_context` and `related_topics` columns | 15min | — |
| 2 | Wire `effectiveConfidence()` as code-driven pre-pass: compute decayed confidence for all memories, write candidates list to temp file. Darwinism prompt reads pre-computed data instead of raw SQL. Aligns with #4 direction (extract computation from LLM conversation). Don't mutate the `confidence` column — keep original LLM-assigned value. | 30min | — |
| 3 | Fix `wake-up-builder.ts`: stop selecting `emotion_arc` column (it's always NULL until `buildArc` is wired in item #4) | 10min | — |
| 4 | Update as-built: remove dead columns from documentation, update "Schema-Only Columns" and "Not Yet Implemented" sections, mark `effectiveConfidence` as wired | 15min | 1-3 |
| 5 | Add steering rule: `.kiro/steering/no-speculative-schema.md` — the principle above | 10min | — |

**Total: ~1hr**

All tasks are independent (can be done in parallel).

Branch: `simplify/dead-code-cleanup`

---

## What stays

| Item | Why | Action |
|---|---|---|
| `source_type` column | Sensible default, future use in trust model | Keep as-is |
| `emotion_arc` column | Wake-up builder reads it, ready for arc building | Keep, stop selecting until wired (item #4) |
| `effectiveConfidence()` | Spaced repetition decay for Darwinism | **Wire now** — task #2 |
| `detectInterference()` | Flags similar-but-different memories during recall | Keep, wire with recall pipeline rewrite (item #1) |
| `buildArc()` | Per-topic emotional trajectory for wake-up | Keep, wire with sleep simplification (item #4) |
| `isFlashbulb()`, `isAgingProtected()` | Live — called by `ageMemoryTiers()` | Already wired |

## What's removed

| Item | Why |
|---|---|
| `last_recall_context` column | Reconsolidation feature — full feature build needed, no near-term path. One-line migration to re-add if needed. |
| `related_topics` column | Cross-topic linking — full feature build needed, no near-term path. One-line migration to re-add if needed. |
