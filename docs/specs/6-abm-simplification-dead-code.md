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

### Functions: remove or keep?

**Remove `detectInterference()` and `buildArc()`.** No runtime caller, no near-term implementation plan. Tests deleted with them. Can be re-implemented from the spec if needed.

**Keep `effectiveConfidence()`.** It's a pure function in `brain-patterns.ts` alongside `isFlashbulb()` and `isAgingProtected()` which ARE used. It has a clear integration point (Darwinism fitness review during sleep). Low cost to keep, likely to be wired soon.

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
| 2 | Remove `detectInterference()` from `brain-patterns.ts` + its tests from `abm-v2-batch-e.test.ts` + export from `index.ts` | 15min | — |
| 3 | Remove `buildArc()` from `emotion-arc.ts` + its tests from `abm-v2-batch-c.test.ts` + export from `index.ts`. If `emotion-arc.ts` is now empty, delete the file. | 15min | — |
| 4 | Fix `wake-up-builder.ts`: stop selecting `emotion_arc` column (it's always NULL). Simplify the SELECT to not reference it. | 10min | — |
| 5 | Update as-built: remove dead columns/functions from documentation, update "Schema-Only Columns" and "Not Yet Implemented" sections | 15min | 1-4 |
| 6 | Add steering rule: `.kiro/steering/no-speculative-schema.md` — the principle above | 10min | — |

**Total: ~1.5hr**

All tasks are independent (can be done in parallel).

Branch: `simplify/dead-code-cleanup`

---

## What stays

| Item | Why |
|---|---|
| `source_type` column | Sensible default, future use in trust model |
| `emotion_arc` column | Wake-up builder reads it, ready for arc building if implemented |
| `effectiveConfidence()` | Pure function, clear integration point (Darwinism), low cost |
| `isFlashbulb()`, `isAgingProtected()` | Live — called by `ageMemoryTiers()` |
