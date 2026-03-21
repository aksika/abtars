# Memory System — Update Journal

## 2026-03-21: Cascade delete for GC + JSONL sync

**Problem:** Sleep cycle GC (Step 1 + Step 2) used raw `DELETE FROM messages` SQL, which only removed rows from the DB. The JSONL transcript — append-only, never pruned — kept growing. After GC, the startup drift check (`checkTranscriptDbDrift`) warned about JSONL vs DB count mismatch, which was a false alarm caused by the one-sided delete.

**Solution:**
- Made `cascadeDelete()` public on MemoryManager. It already handles full cleanup: DB rows, JSONL transcript lines (matched by timestamp:content), embeddings, FTS5 (via trigger).
- Added `--delete-ids <ids> --chat-id <id>` mode to `agentbridge-store` CLI, calling `cascadeDelete()`.
- Updated `sleeping_prompt.md` (deployed + source): Step 1 and Step 2 now use `agentbridge-store --delete-ids` instead of raw SQL.
- Drift check reverted to bidirectional warning — JSONL and DB should stay in sync now.
- Cleaned up duplicate `case` clauses in `agentbridge-store` parseArgs.
- Added 5 tests: parseArgs, DB removal, JSONL removal, empty IDs no-op, non-existent IDs no-op.

**Files changed:** `memory-manager.ts`, `agentbridge-store.ts`, `agentbridge-store.test.ts`, `sleeping_prompt.md` (persona + deployed), `Memory.asbuilt.md`

---

## 2026-03-20: Prompt injection gate on agentbridge-store

**Problem:** Any content with trust < 5 (web-sourced tweets, A2A messages) could be stored to memory without scanning for prompt injection patterns.

**Solution:**
- Wired `prompt-scanner.ts` (22 regex patterns + invisible unicode detection) into `agentbridge-store` for all trust < 5 content.
- On hit: store blocked, JSON error returned, attempt logged to `~/.agentbridge/logs/prompt_injection.log`.
- Baseline audit: all 42 existing memories scanned (regex + LLM) — zero hits. Risk is future-facing (tweet ingestion pipeline).

**Files changed:** `agentbridge-store.ts`, `Memory.asbuilt.md`

---

## 2026-03-20: GraphQL chronological timeline

**Problem:** rettiwt-api guest `user.timeline()` returns all-time top tweets by engagement, not recent. Daily feed was getting stale/irrelevant content (e.g. 1 tweet instead of 12+).

**Solution:**
- Switched to GraphQL `UserTweets` endpoint (`E3opETHurmVJflFsUBVuUQ`) with cookie auth for chronological results.
- Guest fallback via rettiwt-api retained for resilience.
- Raw JSON output to `~/.agentbridge/twitterX/output/tweets-YYYY-MM-DD.json`, `--output` flag added.

**Files changed:** `agentbridge-tweet.ts`
