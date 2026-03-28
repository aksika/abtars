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

## Proposed Pipeline

```
S1 starts → fire embedding request async (non-blocking)
  ↓
S1:   C2 extracted_memories — English FTS5 (content_en)
S1.5: C2 extracted_memories — English+Original LIKE fallback
S2:   C2 extracted_memories — Original FTS5 (ALWAYS, not gated by --original)
  ↓ short-circuit if ≥10 results (discard embedding)
S3:   C2 messages — FTS5
S4:   C2 messages — LIKE (was S5, swapped with consolidation)
S5:   C1 consolidation files (was S4)
S5.5: C5 vector similarity — cosine search using pre-fired embedding result
S6-7: Keyword-free fallback
```

## Execution Order

### Phase 1: Quick wins (no new dependencies)
1. Fix extraction prompt — proper English translation, no meta-commentary
2. Always run S2 — remove `if (params.original)` guard (2 lines)
3. Add S1.5 — LIKE fallback on extracted_memories (10 lines)
4. Swap S4/S5 — messages LIKE before consolidation files (reorder)
5. Manual DB fix — correct the 3 kiskutya memories

### Phase 2: Embeddings (requires ollama)
6. Install ollama + pull nomic-embed-text
7. Wire EmbeddingProvider to ollama endpoint
8. Batch-embed all existing extracted_memories (one-time migration)
9. Add embed-on-insert to agentbridge-store (or Dreamy overnight)
10. Add S5.5 to recall — async embedding fired at S1, consumed at S5.5
11. Update memory.asbuilt.md

## Embedding Architecture

### Model
- `nomic-embed-text` via ollama (274MB, CPU-only, ~20-50ms/query)
- 768-dimension vectors
- Runs locally — zero cost, zero API calls, fully offline

### Storage
- `embeddings` column already exists in `extracted_memories` table (C5)
- Stored as BLOB (768 × 4 bytes = 3KB per memory)
- ~90 memories × 3KB = ~270KB total — negligible

### Embedding lifecycle
- **New memories:** Dreamy embeds during overnight sleep cycle (batch)
- **Instant-store:** embed inline on insert (20ms, acceptable)
- **Migration:** one-time batch embed of all existing memories on first run
- **Stale check:** if embedding is NULL, skip in similarity search (graceful degradation)

### Search flow (S5.5)
```
At S1 start:
  embeddingPromise = ollama.embed(query)    // async, non-blocking

At S5.5 (after S5):
  queryVector = await embeddingPromise      // already resolved (200ms+ elapsed)
  results = cosineSimilarity(queryVector, allStoredVectors)
  filter: score > 0.7 threshold
  merge into result pool with source="C5:embedding"
```

### Decision points
1. **Short-circuit:** If S1+S2 ≥ 10 results → skip S3-S7 including S5.5. Discard embedding promise.
2. **Ollama not running:** S5.5 silently skipped. Log warning once. Recall still works via S1-S5.
3. **No embeddings in DB:** S5.5 returns empty. No error. Dreamy will embed overnight.
4. **Similarity threshold:** 0.7 cosine similarity. Below = noise. Tunable via env var.
5. **Embedding model change:** If model changes, all embeddings must be re-generated (dimension mismatch). Track model name in a metadata row.

## What this solves
- "puppy" finds "kiskutya" (semantic match via embeddings)
- "car" finds "automobile" (synonym match)
- Partial words work via LIKE fallback (S1.5)
- Original language always searched (S2 ungated)
- Zero added latency (embedding fires async at S1)
