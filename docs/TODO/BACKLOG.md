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

**Status:** Not started
**Priority:** Medium
**Source:** Memory refactor R3 (retrospective capability)

Extract durable facts/patterns from daily retro files into `extracted_memories`. Currently retros are written but not mined for persistent knowledge.

## 11. Recall Hit-Rate Logging & Validation

**Status:** Not started
**Priority:** Medium
**Source:** R2 recall cascade refactor

- Add per-stage hit-rate logging to `agentbridge-recall`
- Watch real sleep cycles to validate the 5-stage extracted-first cascade
- Confirm short-circuit at ≥10 results is the right threshold

## 12. MMR Re-Ranking on Recall Output

**Status:** Not started
**Priority:** Low

Apply Maximal Marginal Relevance re-ranking on final recall results to reduce redundancy and improve diversity.

## 13. Daily Backup SQL→JSONL Export

**Status:** Not started
**Priority:** Low

Add a JSONL export step to `daily-backup.sh` for portable/archival format alongside the zip.

## 14. Translation Quality Prompt Fix

**Status:** Not started
**Priority:** Medium
**Source:** aksika's queued enhancement

Improve EN translation quality for jokes, idioms, and culturally-specific expressions in memory extraction.

## 15. Cron Deduplication

**Status:** Not started
**Priority:** Low

Prevent adding the same recurring schedule+message twice in `cron.json`.

## 16. Cron Error Retry

**Status:** Not started
**Priority:** Low

Auto-retry failed script tasks on next cycle instead of just reporting failure.

## 17. Deploy New Skills

**Status:** Not started
**Priority:** High — quick

Run `deploy.sh` to push `healthcheck.md` and updated `cron.md` to live.

## 18. Refurbish Web Dashboard

**Status:** Not started
**Priority:** Medium

Modernize the localhost web dashboard — improve UI/UX, add missing panels, make it more useful for daily ops monitoring.

## 19. /coding Command — Opus as Coding Agent

**Status:** Not started
**Priority:** Medium

Add `/coding` command that routes to Claude Opus as a dedicated coding agent. Separate from the default conversational model — optimized for code generation, refactoring, and debugging tasks.

## 20. Review Testing Strategy

**Status:** Not started
**Priority:** Medium

Audit current test coverage (606 tests / 59 files). Identify gaps, redundant tests, and areas where integration tests would add more value than unit tests. Align with the refactored architecture.

## 21. Improve Security (NemoClaw Ideas)

**Status:** Not started
**Priority:** Medium
**Reference:** NemoClaw project (NVIDIA)

Review NemoClaw's security patterns and apply relevant ideas to AgentBridge — prompt hardening, input sanitization, permission boundaries, agent isolation, etc.
