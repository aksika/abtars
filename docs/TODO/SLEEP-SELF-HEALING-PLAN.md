# Sleep Self-Healing Plan

## Problem

Dreamy (sleep cycle) can detect some issues but can't heal most of them. Several data quality gaps go undetected entirely.

## Current State

### What Dreamy detects and acts on
- FTS5 integrity (3 indexes) — reports ok/corrupt, does NOT rebuild
- Orphaned FTS entries — deletes them
- Orphaned embeddings — deletes them (but checks old `embeddings` table, not `extracted_memories.embedding`)
- Stale sessions — cleans up
- Garbage messages — marks/deletes via 7-step GC
- Near-duplicate memories — merges (never found candidates yet)

### What Dreamy does NOT detect
1. **NULL embeddings** — memories missing embedding vectors (Se sidecar can't find them)
2. **Untranslated content_en** — foreign words in English column (FTS5 miss)
3. **FTS5 corruption** — detects but doesn't rebuild
4. **WAL bloat** — no checkpoint, WAL file can grow unbounded
5. **Embedding count mismatch** — state gatherer counts old `embeddings` table, not `extracted_memories.embedding`
6. **Truncated sleep audits** — 18-line audit suggests early exit or LLM truncation, no self-detection

## Proposed Fixes

### Phase 1: State gatherer fixes (accurate data for Dreamy)

| Fix | What | Where |
|-----|------|-------|
| 1 | Count `extracted_memories WHERE embedding IS NOT NULL` instead of `embeddings` table | `sleep-state-gatherer.ts` |
| 2 | Add `nullEmbeddingCount` — memories missing embeddings | `sleep-state-gatherer.ts` |
| 3 | Add to sleep prompt template: `Embeddings: ${embeddingCount}/${extractedMemoryCount} (${nullEmbeddingCount} missing)` | `sleep-state-gatherer.ts` |

### Phase 2: Self-healing actions in sleep prompt

| Fix | What | Section |
|-----|------|---------|
| 4 | FTS5 auto-rebuild if integrity check fails | §4 Database Maintenance |
| 5 | WAL checkpoint (`PRAGMA wal_checkpoint(TRUNCATE)`) every sleep | §4 Database Maintenance |
| 6 | Batch-embed NULL embeddings if `EMBEDDING_ENABLED=true` | §4 Database Maintenance |
| 7 | Detect untranslated content_en: `SELECT id, content_en FROM extracted_memories WHERE content_en != content_original AND content_en = content_original` — actually this needs a smarter check. Flag memories where content_en contains non-ASCII word sequences for manual review. | §7 Fitness Review |

### Phase 3: Audit quality

| Fix | What |
|-----|------|
| 8 | Minimum audit length check — if sleep output < 50 lines, log warning + retry once |
| 9 | Structured audit sections — sleep prompt should require specific headers so we can validate completeness |

## Execution Order

1. Fix state gatherer — embedding counts (Phase 1: fixes 1-3)
2. Fill "Database Maintenance" section in sleep prompt (Phase 2: fixes 4-6)
3. Add content_en quality check to Fitness Review (Phase 2: fix 7)
4. Audit length validation (Phase 3: fixes 8-9)
5. Update memory.asbuilt.md
6. Tests for state gatherer changes
