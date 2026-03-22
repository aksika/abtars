# Backlog

> ⚠️ **Never delete items from this log.** Completed, cancelled, and closed items stay — they are historical record.

## 8. Context Compression with Tool-Pair Integrity

**Status:** ✅ Closed — out of scope
**Priority:** Low

Auto-compaction already implemented: `checkAutoCompact()` in `memory-manager.ts` triggers `/compact` to kiro-cli when context window exceeds 85%. Tool-pair integrity during compression is a kiro-cli internal concern — outside our control. Additionally, skill compression (56KB → 21KB) and session context reduction (12 → 8 messages) in 2026-03-22 significantly reduced context pressure.

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

**Status:** ✅ Done (2026-03-22)
**Commit:** `0c18307`

Per-stage hit-rate logging added to `agentbridge-recall` on stderr. Format: `[recall] query="..." S1:extracted_en=N S2:extracted_orig=N short_circuit=0|1 S3:messages_fts=N S4:consolidation=N S5:messages_like=N total=N returned=N`. Initial observation: extracted memories rarely reach short-circuit threshold (10) — messages_fts carries most searches. Threshold stays at 10 for now; revisit when extraction volume grows.

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

## 23. TOOLS.md — Always-On Recall Steering

**Status:** ✅ Done (2026-03-22)
**Commit:** `1890eed`

Created `skills/TOOLS.md` with `alwaysApply: true` containing compressed `agentbridge-recall` syntax. Solves the root cause of KP claiming "no access to recall" — the `memory-search.md` skill was `user-invocable: false` (not always loaded), so KP knew the command name from SOUL.md but not the syntax. TOOLS.md ensures recall instructions are always in context.

## 24. Skill Compression

**Status:** ✅ Done (2026-03-22)
**Commit:** `7d6664f`

Compressed all 15 skill files from 56KB to 21KB (63% reduction). Removed tables, verbose examples, redundant explanations. All skills remain functional. Reduces token overhead when skills are loaded.

## 25. SOUL.md Rewrite

**Status:** ✅ Done (2026-03-22)
**Commits:** `2368d0c`, `c468e13`, `530fdd2`, `dc3979d`

- Continuity section rewritten with existential framing ("Saying 'I don't remember' without searching is choosing amnesia over effort")
- Emotions section added (reactions as non-verbal memory, emotion scores woven into recall)
- All second-person ("you are") converted to first-person ("I am") — reads as identity, not instructions
- `<NO_REPLY>` and `[REACT:emoji]` moved to shared section before platform-specific rules

## 26. Agent Emoji Reactions (`[REACT:emoji]`)

**Status:** ✅ Done (2026-03-22)
**Commit:** `3a1721d`

KP can now send emoji reactions on Telegram messages by responding with `[REACT:emoji]` as a standalone response (no text). Works as an expressive alternative to `<NO_REPLY>`. Bridge parses the tag and calls `setMessageReaction`. Also fixed: reactions on synthetic messages (messageId 0) now silently skipped instead of logging errors.

## 27. Session-Start Steering

**Status:** ✅ Done (2026-03-22)
**Commit:** `a14620c`

New `skills/session-start.md` — instructs KP to greet user by name (from `user_profile.md`), reference last session context, and use `agentbridge-recall` for follow-up questions. Operational instructions removed from SOUL.md (where they didn't belong).

## 28. Session Context Reduction

**Status:** ✅ Done (2026-03-22)
**Commit:** `1890eed`

Reduced `RECENT_MSG_LIMIT` from 12 to 8 messages. Combined with TOOLS.md, the trade-off favors always-on recall instructions over more chat history — KP can search for detail on demand.
