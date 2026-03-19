# Memory Darwinism

Created: 2026-03-19
Concept: Memories that get recalled and confirmed survive; the rest fade out. Natural selection for knowledge.

## Prior Art

- Mem-α (arxiv 2509.25911) — RL-trained memory construction with correctness + compression + content quality rewards
- MemRL (arxiv 2601.03192) — episodic memory + RL to learn which strategies work, no weight updates
- UMA — dual memory with CRUD operations including reorganize/merge
- Our approach: lightweight wired signals (recall count, user feedback) instead of formal RL training

## Schema Changes

Five new columns on `extracted_memories`:

| Field | Type | Default | Set by |
|-------|------|---------|--------|
| `recall_count` | INTEGER | 0 | Wired (search layer) |
| `last_recalled_at` | INTEGER | NULL | Wired (search layer) |
| `relevance_score` | INTEGER | 0 | Sleep §1 feedback pass (×10 scaled: +10/-10 explicit, +3/-5 implicit) |
| `confidence` | INTEGER | 3 | LLM at extraction time via agentbridge-store |

## Stage 1: Recall Tracking (wired logic, no LLM)

- [ ] Task 1: Add `recall_count`, `last_recalled_at`, `relevance_score`, `confidence` columns to `extracted_memories` (ALTER TABLE migration in memory-manager.ts)
- [ ] Task 2: After `searchExtracted()` returns results, UPDATE recall_count + last_recalled_at on each hit
- [ ] Task 3: Deduplicate per session — only bump once per memory per session (in-memory Set in search layer)
- [ ] Task 4: `agentbridge-store --confidence <1-5>` flag for write-time certainty rating
- [ ] Task 5: `agentbridge-store --boost --id <N>` (+10) and `--demote --id <N>` (-10) for sleep feedback pass

## Stage 2: Search Ranking Boost (SQL-only, no new fields)

- [ ] Task 6: Modify `searchExtracted()` ORDER BY to factor in recall_count + relevance_score
  - `ORDER BY rank * (1 + 0.1 * recall_count) * CASE WHEN relevance_score > 0 THEN 1.2 ELSE 1.0 END`
  - Closes the Darwinism loop: useful memories surface faster

## Stage 3: Compression Metric (audit only)

- [ ] Task 7: During sleep audit, log `compression_ratio = extracted_count / message_count`
- [ ] Task 8: Add to sleep state snapshot so the sleeping prompt can see it

## Stage 4: Sleep Cycle Restructure

The sleep cycle gains three new phases:

**§1 — Feedback pass (NEW, runs first)**
- [ ] Task 9: Sleep prompt reviews today's conversations
- [ ] Task 10: For each recalled memory that appeared in context: check user reaction
  - User confirmed/continued → `agentbridge-store --boost --id <N>`
  - User corrected/rejected → `agentbridge-store --demote --id <N>`
  - Ambiguous/no reaction → skip (no signal is better than noise)

**§2-§5 — Existing phases** (consolidation, extraction, pruning)
- [ ] Task 11: Extraction instructions updated: include `--confidence <1-5>` on every agentbridge-store call

**§6 — Fitness review (NEW)**
- [ ] Task 12: Add recall_count + relevance_score + last_recalled_at + confidence to sleep state snapshot
- [ ] Task 13: Sleep prompt fitness rules:
  - High recall + high relevance → promote to core knowledge (memory.md)
  - High recall + negative relevance → candidate for deletion or rewording
  - Zero recall after 30+ days → candidate for archival
  - Low confidence + low recall → first to prune
- [ ] Task 14: Time-decayed fitness formula in prompt: `fitness ≈ Σ(1 / (1 + days_since_recall))` weighted by relevance_score

**§7 — Memory merge (NEW, runs last)**
- [ ] Task 15: `agentbridge-store --merge --ids <A>,<B>` — keeps newer record, combines scores (higher relevance_score, summed recall_count, higher confidence), deletes older
- [ ] Task 16: Sleep prompt: review top-N most-recalled memories, merge near-duplicates
  - Max 5 merges per cycle
  - LLM judges similarity — no embedding needed
  - Incremental: small batch each night

## Stage 5: Episodic → Semantic Promotion

- [ ] Task 17: Sleep prompt addition: if a raw message has been recalled 10+ times via L1 search, extract it as a permanent fact via agentbridge-store
- [ ] Task 18: Purely a prompt instruction — original messages naturally age out via existing pruning

## Implementation Order

1. **Stage 1** (tasks 1-5) — schema + wired recall tracking + CLI flags
2. **Stage 2** (task 6) — search ranking boost, immediate payoff from Stage 1 data
3. **Stage 3** (tasks 7-8) — compression metric, one-liner
4. **Stage 4** (tasks 9-14) — sleep cycle restructure, prompt changes only (uses data from stages 1-3)
5. **Stage 5** (tasks 17-18) — episodic promotion, prompt addition
6. **Stage 4 §7** (tasks 15-16) — merge, needs --merge CLI + prompt

## Design Decisions

- All signals stored as integers on existing table — no new tables
- Relevance feedback is batched during sleep §1, not real-time — simpler, more accurate with full context
- Wired logic for counting, LLM for judgment (feedback, merge, promote, prune)
- Decay computed at read time (sleep prompt), not stored — avoids background jobs
- Session dedup prevents inflated counts from retry/rephrase searches
- Merge is incremental (5/cycle) to avoid destructive bulk operations
- Confidence is self-assessed by LLM at extraction time — cheap signal, useful tiebreaker
