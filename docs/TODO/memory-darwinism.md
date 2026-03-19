# Memory Darwinism

Created: 2026-03-19
Concept: Memories that get recalled and confirmed survive; the rest fade out. Natural selection for knowledge.

## Prior Art

- Mem-α (arxiv 2509.25911) — RL-trained memory construction with correctness + compression rewards
- MemRL (arxiv 2601.03192) — episodic memory + RL to learn which strategies work, no weight updates
- UMA — dual memory with CRUD operations including reorganize/merge
- Our approach: lightweight wired signals (recall count, user feedback) instead of formal RL training

## Stage 1: Recall Tracking (wired logic, no LLM)

- [ ] Task 1: Add `recall_count INTEGER DEFAULT 0` and `last_recalled_at INTEGER` columns to `extracted_memories`
- [ ] Task 2: After `searchExtracted()` returns results, UPDATE recall_count + last_recalled_at on each hit
- [ ] Task 3: Deduplicate per session — only bump once per memory per session (in-memory Set in search layer)

## Stage 2: Relevance Scoring (explicit + implicit feedback)

- [ ] Task 4: Add `relevance_score INTEGER DEFAULT 0` column to `extracted_memories`
- [ ] Task 5: `agentbridge-store --boost --id <N>` (+1) and `--demote --id <N>` (-1) — explicit signal from kiro
- [ ] Task 6: Steering instruction: after recalling a memory, if user confirms → boost, if user corrects → demote
- [ ] Task 7: Implicit detection via IntentDetector — add "memory confirmation" and "memory rejection" patterns
  - Confirmation: user says "yes", "exactly", "right", continues on topic → +0.3
  - Rejection: "no", "that's wrong", "I never said that" → -0.5
  - Only fires when a recall happened in the previous turn

## Stage 3: Compression Metric (one-liner, audit only)

- [ ] Task 8: During sleep audit, log `compression_ratio = extracted_count / message_count`
- [ ] Task 9: Add to sleep state snapshot so the sleeping prompt can see it and adjust extraction aggressiveness

## Stage 4: Sleep-Time Fitness Actions

- [ ] Task 10: Add recall_count + relevance_score + last_recalled_at to sleep state snapshot
- [ ] Task 11: Sleep prompt §-addition: review top-N recalled memories
  - High recall + high relevance → promote to core knowledge (memory.md)
  - High recall + negative relevance → candidate for deletion or rewording
  - Zero recall after 30+ days → candidate for archival
- [ ] Task 12: Time-decayed scoring formula in sleep prompt: `fitness = Σ(1 / (1 + days_since_recall))` weighted by relevance_score

## Stage 5: Episodic → Semantic Promotion

- [ ] Task 13: Sleep prompt §-addition: if a raw message (episodic) has been recalled 10+ times, extract it as a permanent fact (semantic)
- [ ] Task 14: This is purely a prompt instruction — kiro calls agentbridge-store to create the extracted memory, then the original messages naturally age out

## Stage 6: Memory Merge (end-of-sleep agentic pass)

- [ ] Task 15: `agentbridge-store --merge --ids <A>,<B>` — keeps newer record, combines scores (higher relevance_score, summed recall_count), deletes older
- [ ] Task 16: Sleep prompt §7 (final phase): review top-N most-recalled extracted memories, merge near-duplicates
  - Max 5 merges per cycle
  - LLM judges similarity — no embedding/cosine needed
  - Incremental: small batch each night, not full DB scan

## Implementation Order

1. Stage 1 + 3 (recall tracking + compression metric) — pure wired logic, no LLM changes
2. Stage 2 tasks 4-6 (explicit boost/demote) — one CLI flag + steering
3. Stage 4 (sleep fitness actions) — prompt changes only, uses data from stages 1-2
4. Stage 5 (episodic promotion) — prompt addition
5. Stage 2 task 7 (implicit detection) — IntentDetector extension, lower priority
6. Stage 6 (merge) — last, needs --merge CLI + prompt §7

## Design Decisions

- All signals stored as simple integers on existing table — no new tables
- Wired logic for counting, LLM for judgment (merge, promote, prune decisions)
- Decay is computed at read time (sleep prompt), not stored — avoids background jobs
- Session dedup prevents inflated counts from retry/rephrase searches
- Merge is incremental (5/cycle) to avoid destructive bulk operations
