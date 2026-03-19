# Recall Cascade Refactor

Created: 2026-03-20
Status: Future — implement after Memory Darwinism is live and generating data
Depends on: Memory Darwinism Stage 1-2 (recall tracking + ranking boost)

## Current Order (8 stages, bottom-up legacy)

1. FTS5 on `messages` (raw)
2. Relaxed FTS5 on `messages` (OR-style)
3. Substring LIKE on `messages` (accent-insensitive)
4. Original-language substring on `messages`
5. Extracted memories — English FTS5
6. Extracted memories — original language FTS5
7. Consolidation file keyword search (grep on .md files)
8. chat_backup LIKE fallback

## Problem

Extracted memories (stages 5-6) are the clean, curated, scored signal — but they run after 4 stages of noisy raw message search. Darwinism makes this worse: we'll have recall_count + relevance_score + confidence on extracted memories, but they're searched late.

## Proposed Order (5 stages, top-down)

1. **Extracted memories — English FTS5** (with Darwinism ranking boost)
2. **Extracted memories — original language FTS5** (with Darwinism ranking boost)
3. **Raw messages — FTS5 + relaxed FTS5** (merge current stages 1-2)
4. **Consolidation summaries** (move from file grep to FTS5 table)
5. **chat_backup LIKE fallback** (safety net, unchanged)

## Changes

- **Flip order**: extracted memories first, raw messages as fallback
- **Merge stages 1-2**: strict + relaxed FTS5 in one query (OR with boosted exact matches)
- **Drop stages 3-4**: LIKE substring searches are expensive, rarely add unique results over relaxed FTS5
- **Consolidation to DB**: new `consolidation_fts` table replaces file grep — proper ranking, not just keyword presence
- **Short-circuit**: if stages 1-2 return ≥10 results with high Darwinism scores, skip stages 3-5

## Why After Darwinism

- Darwinism Stage 2 adds ranking boost to extracted memory queries — the reorder only pays off once those scores exist
- Recall tracking data (Stage 1) tells us empirically which stages actually contribute results — we can validate the "drop stages 3-4" decision with data instead of guessing
- Consolidation-to-DB migration is a schema change that shouldn't be mixed with Darwinism schema changes
