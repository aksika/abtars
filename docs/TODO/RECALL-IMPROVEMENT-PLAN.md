# Memory Recall Improvement Plan

## Problem

The recall pipeline has three gaps that cause missed results:

### 1. Poor extraction translation
The LLM extraction prompt produces `content_en` that contains untranslated foreign words. Example: `content_en = "kiskutya fasza = 5 centi"` instead of `"puppy's penis = 5 cm (kiskutya fasza)"`. Searching "puppy" in S1 (English FTS5) returns nothing because the English word doesn't exist in the field.

Root cause: The extraction prompt says "translate to English" but the LLM treats foreign words as proper nouns and preserves them verbatim. It also wraps memories in meta-commentary.

### 2. No LIKE fallback on extracted_memories
The recall pipeline has LIKE fallback for raw messages (S5) but not for extracted memories. If FTS5 misses a partial match on `content_en` or `content_original`, there's no safety net.

### 3. S2 only runs when `--original` is provided
The agent must explicitly pass `--original <keyword>` for original-language search to run. If the agent doesn't know the conversation was in Hungarian, S2 is skipped entirely.

## Two Search Paths

There are two independent search implementations:

| Path | File | Used by | Priority |
|------|------|---------|----------|
| `agentbridge-recall` | `src/cli/agentbridge-recall.ts` | KP (agent) | **Primary** — this is how the agent remembers |
| `MemorySearchController` | `src/components/memory-search-controller.ts` | Dashboard (human) | Secondary — debug/inspection tool |

This plan targets `agentbridge-recall`. Dashboard search can inherit the same fixes later.

## Current Pipeline (agentbridge-recall)

```
S1: Extracted memories — English FTS5 (content_en)
S2: Extracted memories — Original FTS5 (content_original)  ← only if --original
  → short-circuit if ≥10 results
S3: Raw messages — FTS5 (relaxed OR)
S4: Consolidation files (disk)
S5: Raw messages — LIKE
S6-S7: Keyword-free fallback
```

## Proposed Pipeline

```
Se: async embedding ──────────────────────┐  (fire-and-forget at S1 start)
                                           │
S1: Extracted — English FTS5               │
S2: Extracted — Original FTS5 (ALWAYS)     │
S3: Extracted — LIKE fallback (new)        │
  → merge Se results here ◄───────────────┘
  → short-circuit if ≥10 results
S4: Messages — FTS5
S5: Messages — LIKE
S6: Consolidation files
S7: Keyword-free fallback
```

Changes from current:
- S2 always runs (remove `--original` gate)
- S3 is new (LIKE on extracted_memories)
- Se is new (async embedding sidecar)
- Short-circuit moves from after S2 → after Se merge
- Old S4/S5 swapped (messages LIKE is faster than disk consolidation search)

## Execution Order

### Phase 1: Quick wins (no new dependencies)
1. Fix extraction prompt — always translate to English, no meta-commentary
2. Always run S2 — remove `if (params.original)` guard
3. Add S3 — LIKE fallback on `content_en` and `content_original`
4. Reorder S4-S6 — messages LIKE before consolidation files
5. Audit + fix existing bad memories (kiskutya + any others with untranslated content_en)

### Phase 2: Embeddings (requires ollama)
6. Install ollama + pull nomic-embed-text
7. Wire EmbeddingProvider to ollama endpoint
8. Batch-embed all existing extracted_memories (one-time migration)
9. Add embed-on-insert to Dreamy sleep cycle + agentbridge-store
10. Add Se sidecar to recall — async fire at S1, consume after S3
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

All embedding functionality is gated behind `EMBEDDING_ENABLED=true`. When disabled, Se is absent — no ollama dependency, no errors, recall works via S1-S7.

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
1. **Short-circuit:** If S1+S2+S3+Se ≥ 10 results → skip S4-S7. Discard embedding if not yet resolved.
2. **Ollama not running:** Se silently skipped. Log warning once. Recall works via S1-S7.
3. **No embeddings in DB:** Se returns empty. No error. Dreamy will embed overnight.
4. **Similarity threshold:** 0.7 cosine similarity. Below = noise. Tunable via env var.
5. **Embedding model change:** All embeddings must be re-generated (dimension mismatch). Track model name in a metadata row.

## What this solves
- "puppy" finds "kiskutya" (semantic match via Se embeddings)
- Partial words work via LIKE fallback (S3)
- Original language always searched (S2 ungated)
- Zero added latency (Se fires async at S1)
