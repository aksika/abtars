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
Se: fires at S1 ──────────────────────────┐
                                           │ (async, ~20-50ms, ollama)
S1: Extracted — English FTS5               │
S2: Extracted — Original FTS5              │
S3: Extracted — LIKE fallback              │
  → merge Se results here ◄───────────────┘
  → short-circuit if ≥10 results
S4: Messages — FTS5
S5: Messages — LIKE
S6: Consolidation files
S7: Keyword-free fallback
```

Se is a sidecar, not a sequential stage. Fires with S1, consumed after S3. If ollama is slow or disabled, Se is simply absent — no impact on S1-S7.

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

### Configuration (env vars)
```env
# Embedding search — disabled by default, requires ollama
EMBEDDING_ENABLED=false
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_URL=http://localhost:11434
EMBEDDING_SIMILARITY_THRESHOLD=0.7
```

All embedding functionality is gated behind `EMBEDDING_ENABLED=true`. When disabled, S5.5 is skipped entirely — no ollama dependency, no errors, recall works via S1-S5.

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

### Search flow (Se sidecar)
```
At S1 start:
  if EMBEDDING_ENABLED:
    embeddingPromise = ollama.embed(query)    // async, non-blocking

After S3 (before short-circuit check):
  if embeddingPromise resolved:
    queryVector = await embeddingPromise
    results = cosineSimilarity(queryVector, allStoredVectors)
    filter: score > threshold
    merge into result pool with source="Se:embedding"
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
