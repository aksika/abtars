# Backlog

## 8. Context Compression with Tool-Pair Integrity

**Status:** Not started
**Priority:** Low — implement when context windows become a bottleneck
**Source:** Hermes `context_compressor.py` study (2026-03-14)

**Problem:**
Long sessions or large `.chat` transcripts waste tokens on stale context. Naive truncation can split tool-call / tool-result pairs, confusing the model.

**Hermes approach:**
- Mid-session compression that identifies tool-call + tool-result pairs and keeps them atomic
- Compresses older turns while preserving recent context
- Maintains a "compressed summary" prefix so the model knows what happened earlier

**Open questions:**
1. Document only vs implement for `.chat` files vs implement for live sessions?
2. Should compression run during sleep cycle (offline) or mid-session (online)?
3. What's the trigger — token count threshold, turn count, or time-based?

**Reference:** `docs/specs/hermes-injection-scanning.study.md` (same study session), Hermes source at `/home/qakosal/workspace/hermes-agent/agent/context_compressor.py`

## 9. Memory Store Injection Scanning (defense-in-depth)

**Status:** Not started
**Priority:** Low — A2A prompt scanning already blocks poisoned input at entry point
**Source:** Gap review of Hermes study (2026-03-14)

**Problem:**
If a poisoned prompt somehow bypasses A2A scanning, kiro could store poisoned memories via `agentbridge-store`. These persist in SQLite and get injected into future sessions via recall.

**Proposed approach:**
Reuse `scanPrompt()` from `prompt-scanner.ts` on `--content-en` and `--content-original` in `agentbridge-store.ts`. On match: skip the save, log warning.

**Why low priority:**
The A2A prompt scanner (22 patterns) catches injection at the entry point. For a poisoned memory to enter the DB, the attacker would need to bypass the prompt scanner AND trick kiro into extracting+storing the payload — double barrier already exists.

## 10. Derived Facts from Retrospective

**Status:** ✅ Done (2026-03-22)
**Commit:** `d2e3a75`

New CLI `agentbridge-retro-extract`: parses retro markdown, extracts bullets from "What did I learn?" (→ fact) and "How can I improve?" (→ decision), stores via `instantStore()`. Wired into sleep cycle as Phase 5.5. Tracks processed files in `.processed.json` (idempotent). 13 items extracted from first retro.

## 11. Recall Hit-Rate Logging & Validation

**Status:** Not started
**Priority:** Medium
**Source:** R2 recall cascade refactor

- Add per-stage hit-rate logging to `agentbridge-recall`
- Watch real sleep cycles to validate the 5-stage extracted-first cascade
- Confirm short-circuit at ≥10 results is the right threshold

## 12. MMR Re-Ranking on Recall Output

**Status:** ✅ Done (2026-03-22)
**Commit:** `2f9d487`

Jaccard token similarity + MMR re-ranking (λ=0.7) applied as post-processing in agentbridge-recall after dedup and sort. New file: `src/components/mmr.ts`. 8 tests added.

## 13. Daily Backup SQL→JSONL Export

**Status:** ❌ Cancelled
**Reason:** JSONL eliminated in R1 refactor. SQLite is the single source of truth; zip backup of memory.db is sufficient.

## 14. Translation Quality Prompt Fix

**Status:** ✅ Done (2026-03-22)
**Commit:** `998d93d`

Improved extraction prompt: meaning-first translation, tone context for jokes/sarcasm, cultural reference annotations. Also manually fixed 5 memories (#24 joke punchline, #33-36 content_original language issues). Decision documented in `memory.decisions.md`.

## 15. Cron Deduplication

**Status:** ✅ Done (2026-03-22)

Recurring entries with same schedule+message+chatId are rejected on add. Returns `{"ok":false,"error":"duplicate","existing_id":"..."}`. Paused entries are excluded from the check.

## 16. Cron Error Retry

**Status:** ✅ Done (2026-03-22)
**Commit:** `2ae7446`

Auto-retry failed tasks 2 cycles later (10min). One retry only — no infinite loops. Works for both script and agent executors.

## 17. Deploy New Skills

**Status:** ✅ Done (2026-03-22)

Run `deploy.sh` to push `healthcheck.md` and updated `cron.md` to live.

## 18. Refurbish Web Dashboard

**Status:** Not started
**Priority:** Medium

Modernize the localhost web dashboard — improve UI/UX, add missing panels, make it more useful for daily ops monitoring.

## 19. /coding Command — Opus as Coding Agent

**Status:** ✅ Done
**Commit:** `816157e`

Add `/coding` command that routes to Claude Opus as a dedicated coding agent. Separate from the default conversational model — optimized for code generation, refactoring, and debugging tasks.

## 20. Review Testing Strategy

**Status:** Not started
**Priority:** Medium

Audit current test coverage (606 tests / 59 files). Identify gaps, redundant tests, and areas where integration tests would add more value than unit tests. Align with the refactored architecture.

## 22. Picture / Media Support

**Status:** Not started
**Priority:** Medium
**Source:** OpenClaw media handling study (memory refactor), user request (2026-03-22)

**Problem:**
AgentBridge is text-only. Users can't send images to the bot (screenshots, diagrams, photos) and the bot can't send images back. This limits usefulness for visual debugging, sharing context, and richer interactions.

**Scope (initial assessment):** `docs/specs/picture-support.assessment.md`

**Reference:** OpenClaw `src/agents/tool-images.ts`, `src/media-understanding/attachments.cache.ts`, `src/web/media.ts` — studied during memory refactor, kept as future reference for big file / media patterns.

## 21. Improve Security (NemoClaw Ideas)

**Status:** Not started
**Priority:** Medium
**Reference:** NemoClaw project (NVIDIA)

Review NemoClaw's security patterns and apply relevant ideas to AgentBridge — prompt hardening, input sanitization, permission boundaries, agent isolation, etc.
