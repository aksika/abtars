# Memory Recall Improvement Plan

## Problem

The recall pipeline has two gaps that cause missed results:

### 1. Poor extraction translation
The LLM extraction prompt produces `content_en` that contains untranslated foreign words. Example: `content_en = "kiskutya fasza = 5 centi"` instead of `"puppy's penis = 5 cm (kiskutya fasza)"`. Searching "puppy" or "penis" in S1 (English FTS5) returns nothing because those English words don't exist in the field.

Root cause: The extraction prompt says "translate to English" but the LLM treats foreign words as proper nouns/keywords and preserves them verbatim. It also wraps memories in meta-commentary ("These are persistent memory test items aksika uses to verify recall works") which pollutes the actual content.

### 2. No LIKE fallback on extracted_memories
The recall pipeline has LIKE fallback for raw messages (S5) but not for extracted memories. If FTS5 misses a partial match on `content_en` or `content_original`, there's no safety net. S5 searches raw messages which are noisy and may have been garbage-collected.

### 3. S2 only runs when `--original` is provided
The agent must explicitly pass `--original <keyword>` for original-language search to run. If the agent doesn't know the conversation was in Hungarian, it won't pass `--original` and S2 is skipped entirely.

## Current Recall Pipeline (agentbridge-recall)

```
S1: Extracted memories — English FTS5 (content_en)
    ↓ if --original provided
S2: Extracted memories — Original FTS5 (content_original)
    ↓ short-circuit if ≥10 results
S3: Raw messages FTS5 (relaxed OR)
S4: Consolidation file search (daily/weekly .md)
S5: Raw messages LIKE (wide net fallback)
S6-7: Keyword-free fallback (if zero results)
```

## Proposed Fixes

### Fix 1: Extraction prompt (prevents future bad data)
- Always translate ALL words to English in `content_en`
- Format: "English meaning (original word)" when preserving context
- Never include meta-commentary about tests, verification, or why something was said
- Cost: 0 (prompt change only)

### Fix 2: LIKE fallback on extracted_memories (new S1.5)
After S1 FTS5, if results < limit, run LIKE search on `content_en` and `content_original`:
```sql
SELECT * FROM extracted_memories
WHERE content_en LIKE '%keyword%' OR content_original LIKE '%keyword%'
```
- Catches partial matches FTS5 misses
- Lower score (0.4) than FTS5 results
- Cost: ~5 lines in agentbridge-recall + memory-index

### Fix 3: Always run S2 (original language search)
Pass the same keywords to S2 even without `--original`. The original FTS5 index handles both languages — if the keyword is English it just won't match Hungarian text (harmless). If it IS Hungarian, it finds it.
- Cost: 2 lines in agentbridge-recall (remove the `if (params.original)` guard)

### Fix 4: Manual correction of existing bad memories
Update the 3 kiskutya memories in the DB to have proper English translations.
- One-time SQL update

## Execution Order
1. Fix 1 (extraction prompt) — prevents future issues
2. Fix 3 (always run S2) — 2-line change, immediate improvement
3. Fix 2 (LIKE fallback) — safety net for partial matches
4. Fix 4 (manual DB correction) — fixes existing data
5. Update memory.asbuilt.md
