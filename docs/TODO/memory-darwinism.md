# Memory Darwinism

Created: 2026-03-19
Concept: Memories that get recalled and confirmed survive; the rest fade out. Natural selection for knowledge.

## Prior Art

- Mem-α (arxiv 2509.25911) — RL-trained memory construction with correctness + compression + content quality rewards
- MemRL (arxiv 2601.03192) — episodic memory + RL to learn which strategies work, no weight updates
- UMA — dual memory with CRUD operations including reorganize/merge
- Our approach: lightweight wired signals (recall count, user feedback) instead of formal RL training

## Schema Changes

Five new columns on `extracted_memories` (single ALTER TABLE migration, includes LCM source linking):

| Field | Type | Default | Set by |
|-------|------|---------|--------|
| `recall_count` | INTEGER | 0 | Wired (search layer) |
| `last_recalled_at` | INTEGER | NULL | Wired (search layer) |
| `relevance_score` | INTEGER | 0 | Sleep §1 feedback pass (×10 scaled: +10/-10 explicit, +3/-5 implicit) |
| `confidence` | INTEGER | 3 | LLM at extraction time via agentbridge-store |
| `source_message_ids` | TEXT | NULL | agentbridge-store --source-ids (from LCM plan) |

## Stage 1: Recall Tracking + Source Linking (wired logic, no LLM)

- [ ] Task 1: Add all 5 columns to `extracted_memories` (single ALTER TABLE migration in memory-manager.ts)
- [ ] Task 2: After `searchExtracted()` returns results, UPDATE recall_count + last_recalled_at on each hit
- [ ] Task 3: Deduplicate per session — only bump once per memory per session (in-memory Set in search layer)
- [ ] Task 4: `agentbridge-store` new flags: `--confidence <1-5>`, `--boost --id <N>` (+10), `--demote --id <N>` (-10), `--source-ids <csv>`
- [ ] Task 5: Create `agentbridge-expand --ids 451,452,453` CLI (read-only, JSON output) + steering file
- [ ] Task 6: Update agentbridge-recall output to show expand hints when source IDs exist

## Stage 2: Search Ranking Boost (SQL-only, no new fields)

- [ ] Task 7: Modify `searchExtracted()` ORDER BY to factor in recall_count + relevance_score
  - `ORDER BY rank * (1 + 0.1 * recall_count) * CASE WHEN relevance_score > 0 THEN 1.2 ELSE 1.0 END`
  - Closes the Darwinism loop: useful memories surface faster

## Stage 3: Compression Metric (audit only)

- [ ] Task 8: During sleep audit, log `compression_ratio = extracted_count / message_count`
- [ ] Task 9: Add compression ratio + recall/relevance stats to sleep state snapshot (single gatherer update)

## Stage 4: Sleep Cycle Restructure

The sleep cycle gains three new phases. Single prompt rewrite covers all changes including LCM consolidation source linking.

**§1 — Feedback pass (NEW, runs first)**
- [ ] Task 10: Sleep prompt reviews today's conversations
- [ ] Task 11: For each recalled memory that appeared in context: check user reaction
  - User confirmed/continued → `agentbridge-store --boost --id <N>`
  - User corrected/rejected → `agentbridge-store --demote --id <N>`
  - Ambiguous/no reaction → skip (no signal is better than noise)

**§2-§5 — Existing phases** (consolidation, extraction, GC, cron)
- [ ] Task 12: Extraction instructions updated: include `--confidence <1-5>` and `--source-ids` on every agentbridge-store call
- [ ] Task 13: Consolidation sections include `## Sources` with message ID ranges (LCM Stage 4)

**§6 — Fitness review (NEW)**
- [ ] Task 14: Sleep prompt fitness rules:
  - High recall + high relevance → no action needed (search ranking boost handles surfacing)
  - High recall + negative relevance → candidate for deletion or rewording
  - Zero recall after 60+ days → candidate for archival
  - Low confidence + low recall → first to prune
- [ ] Task 15: Time-decayed fitness formula in prompt: `fitness ≈ Σ(1 / (1 + days_since_recall))` weighted by relevance_score
- [ ] Task 16: Core knowledge maintenance — review `core/user_profile.md` + `core/agent_notes.md`, prune stale/redundant lines, keep each file ≤10 lines of high-signal facts only. These files are injected into every context window so brevity is critical.

**§7 — Memory merge (NEW, runs last)**
- [ ] Task 17: `agentbridge-store --merge --ids <A>,<B>` — keeps newer record, combines scores (higher relevance_score, summed recall_count, higher confidence), deletes older
- [ ] Task 18: Sleep prompt: review top-N most-recalled memories, merge near-duplicates
  - Max 5 merges per cycle
  - LLM judges similarity — no embedding needed
  - Incremental: small batch each night

## Implementation Order

1. **Stage 1** (tasks 1-6) — schema + wired recall tracking + CLI flags + source linking + expand
2. **Stage 2** (task 7) — search ranking boost, immediate payoff from Stage 1 data
3. **Stage 3** (tasks 8-9) — compression metric + snapshot stats
4. **Stage 4** (tasks 10-16) — sleep cycle restructure, single prompt rewrite (uses data from stages 1-3)
5. **Stage 4 §7** (tasks 17-18) — merge, needs --merge CLI + prompt

## Design Decisions

- All signals stored as integers on existing table — no new tables
- Relevance feedback is batched during sleep §1, not real-time — simpler, more accurate with full context
- Wired logic for counting, LLM for judgment (feedback, merge, promote, prune)
- Decay computed at read time (sleep prompt), not stored — avoids background jobs
- Session dedup prevents inflated counts from retry/rephrase searches
- Merge is incremental (5/cycle) to avoid destructive bulk operations
- Confidence is self-assessed by LLM at extraction time — cheap signal, useful tiebreaker
- Core knowledge files kept but maintained minimal (≤10 lines each) by sleep fitness review
