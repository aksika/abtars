# Backlog

> ⚠️ **Never delete items from this log.** Completed, cancelled, and closed items stay — they are historical record.

## 8. Context Compression with Tool-Pair Integrity

**Status:** ✅ Closed — out of scope
**Priority:** Low

Auto-compaction already implemented: `checkAutoCompact()` in `memory-manager.ts` triggers `/compact` to kiro-cli when context window exceeds 85%. Tool-pair integrity during compression is a kiro-cli internal concern — outside our control. Additionally, skill compression (56KB → 21KB) and session context reduction (12 → 8 messages) in 2026-03-22 significantly reduced context pressure.

## 9. Memory Store Injection Scanning (defense-in-depth)

**Status:** Not started
**Priority:** Low
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

**Status:** ✅ Done (2026-03-23)
**Commit:** `b3c8cf8`

Modernize the localhost web dashboard — improve UI/UX, add missing panels, make it more useful for daily ops monitoring. Added: cron panel (schedule, next fire, pause/resume/trigger), heartbeat task list, log viewer sidebar (24h, level filters, auto-refresh). Layout changed to flex row (cards left, log right).

## 19. /coding Command — Opus as Coding Agent

**Status:** ✅ Done
**Commit:** `816157e`

Add `/coding` command that routes to Claude Opus as a dedicated coding agent. Separate from the default conversational model — optimized for code generation, refactoring, and debugging tasks.

## 20. Review Testing Strategy

**Status:** ✅ Done (2026-03-27)

Covered in system engineering refactor v2: 654 tests across 66 files. Added command-handlers tests, updated cron tests for SQLite. Remaining gaps tracked in REFACTOR-V2-PLAN.md Phase E1.

## 22. Picture / Media Support

**Status:** Partial — receiving done, sending not implemented
**Priority:** Medium
**Source:** OpenClaw media handling study (memory refactor), user request (2026-03-22)

**Done:**
- Telegram + Discord: photos/documents downloaded and saved to `~/.agentbridge/received/media/`
- File path appended to prompt (`File saved at: ...`) — KP can read images via kiro-cli tools
- Sleep §9.5 media cleanup (FIFO 100MB budget)

**Remaining:**
- KP cannot send images back to the user (no `sendPhoto` / `sendImage` on adapters)

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

## 29. Heartbeat Heavy-Task Gating + Cron Priority

**Status:** ✅ Done (2026-03-23)
**Commits:** `0f941b5`, `a3c40f5`

Cold-start stampede fix: all cron tasks + sleep fired simultaneously on first tick. Now:
- `HeartbeatTask` has `heavy` flag + boolean return. `tick()` skips remaining heavy tasks after one returns true.
- `CronEntry` has `priority?: "high"` field. Two heartbeat tasks: `cron-priority` (not heavy, fires high-priority entries like backup) and `cron-normal` (heavy, fires 1 task per tick).
- Registration order: cron-priority → sleep → cron-normal → browse → reminder.
- Backup runs before sleep, sleep runs before research tasks. No two heavy things overlap.
- Logger marks test entries with `TEST` prefix to distinguish from production logs.

## 30. Financial AI News Pipeline + agentbridge-rss

**Status:** ✅ Done (2026-03-23)
**Commit:** `c505ff0`

New `agentbridge-rss` CLI tool — fetches RSS/Atom feeds (SEC EDGAR 8-K, Google News AI Finance, CNBC Tech/Investing, Seeking Alpha per watchlist ticker), outputs JSON to `~/.agentbridge/finance/rss-YYYY-MM-DD.json`. Zero dependencies, regex XML parsing.

Cron entry: weekdays 1pm, agent executor. Pipeline: run agentbridge-rss → read AI-Daily report from morning → cross-reference → rank by market impact → write Finance-AI-Daily report → propose new tickers to watchlist.

Stock watchlist at `~/.agentbridge/finance/stock_watchlist.md` — Active tickers get Seeking Alpha RSS, agent proposes new ones under Proposed section.

## 31. AI News Pipeline Consolidation

**Status:** ✅ Done (2026-03-23)
**Commit:** `a3c40f5`

Consolidated tweet-feed script + AI-news browse agent into 1 agent cron entry. Pipeline: collect tweets → browse techcrunch/arstechnica/theverge → cross-reference → write report. Retired standalone tweet-feed cron entry.

## 32. Unified Command Handlers

**Status:** ✅ Done (2026-03-23)
**Commit:** `bf2b42c`

Extracted all chat command handlers from main.ts into `src/components/command-handlers.ts`. Single module for Telegram + Discord — 840 lines removed from main.ts. Platform-specific commands check `ctx.platform` internally.

Removed: /ingest, /reflect, /reembed, /forget (memories only come from conversations/agent work, not manual injection). Merged /mcporter into /status. Renamed /a2a-reset to /a2a-reset. Discord gained /coding, /stop, /cancel, /facts.

## 33. Email Digest via Google Workspace CLI

**Status:** ✅ Done (2026-03-23)

KP reads Gmail natively using `gws` CLI (`@googleworkspace/cli`). No wrapper needed — agent calls `gws gmail` commands directly via bash.

Setup: `npm install -g @googleworkspace/cli` + `gws auth login` (one-time OAuth via manual client_secret.json). Integrated into AI news pipeline (cron `02565e`): agent searches Gmail for AI-related emails from last 24h, reads content, marks as read, and aggregates into the daily AI report.

## 34. A2A Protocol Review — Proper Handshake & Session Lifecycle

**Status:** ✅ Done (2026-03-25)
**Commits:** `3239745`..`5c9bdc4`

Implemented HMAC-SHA256 challenge-response auth on single endpoint (`/api/agent/prompt`):
- Hello/hello-ack handshake — mutual auth, shared secret never on wire
- Session lifecycle: explicit close + idle timeout safety net
- `[KP]` / `[Molty]` (max 15 chars) prefixes in logs and traffic
- Rude guest handling: KP sends hello+challenge, blocks until authenticated
- Bearer token header removed
- OpenClaw plugin updated with handshake support, deployed to Mac, saved in `plugins/openclaw-kiro-professor/`
- Passed Molty's social engineering security test

## 35. Ops Hardening — Cron, Lifecycle, Healthcheck

**Status:** ✅ Done (2026-03-24/25)
**Commits:** `b5cfc47`..`39d9c44`

Batch of operational fixes:
- Cron: 3 priority levels (HIGH/MEDIUM/LOW), catchup sorted by priority then latest-first. Failed tasks revert fireAt (re-fire next tick). ACP handshake fixed (initialize → session/new → session/prompt with incremental line parsing). First heartbeat tick skipped (let bridge finish startup).
- Lifecycle: tmux session + mcporter daemon managed by bridge (not launcher). `MCPORTER_DAEMON` .env flag. Shutdown timeout 5s→20s. Doctor `--fix` at startup, orphan kiro-cli detection+kill.
- Dashboard: heartbeat merged to single line, `/cron` clean monospace table with ✓/○/— status.
- Poller: transient retries downgraded to WARN (ERROR only after 3+).
- Reports moved inside `~/.agentbridge/reports/`, added to daily backup with `finance/`.
- Startup greeting prompt to kiro-cli with session context ("You just woke up").
- Sleep audit filenames normalized to `YYYYMMDD_HHMM`.

- Sleep prompt needs explicit instructions: "Replace any SECRET or CONFIDENTIAL memory content with `<REDACTED>` in daily summaries and retrospectives"

## 36. Unified Platform Abstraction

**Status:** ✅ Done (2026-03-25)
**Branch:** `refactor/unified-platform-abstraction` (merged to main)

Major refactor: extracted Telegram/Discord into a shared PlatformAdapter pattern with a unified message pipeline. Adding new platforms (Slack, WhatsApp) is now ~100 lines.

- `PlatformAdapter` interface + `InboundMessage` type (`src/types/platform.ts`)
- `message-pipeline.ts`: shared prompt→transport→response→delivery flow
- `TelegramAdapter`: voice, reactions, groups, typing, TTS
- `DiscordAdapter`: A2A, mention stripping, reactions (new)
- `SleepQueue`: platform-agnostic sleep message queueing
- `CodingMode`: coding agent transport lifecycle
- `IdleSave`: idle chat save timers
- Consolidated env-utils, shared test helpers
- Deleted dead code: PlatformController, TransportController, ChannelAdapter, BridgeMessage
- main.ts: 1265 → 617 lines (-51%)

## 37. CronQueue — Sequential Job Processor

**Status:** ✅ Done (2026-03-25) — needs live testing

Replaced inline task spawning in cron-checker with a proper job queue.

- `checkCron()` is now a pure scanner: returns due tasks, no spawning
- `CronQueue` processes tasks sequentially: scripts fire freely, agents 1-at-a-time
- 30-min hard timeout on agent tasks (SIGKILL)
- Priority-sorted queue: high jobs jump ahead of pending medium/low
- Duplicate prevention: same entry ID can't be queued or running twice
- Retry once on failure: skip 1 heartbeat cycle, then retry. If retry fails too, wait for next scheduled time
- Merged cron-priority/cron-normal into single heartbeat task
- `/cron` shows running job PID + status icons: + pending, ~ running, ✓ succeeded, — skipped
- Heartbeat skips ticks until uptime > 3 minutes
- **Needs live testing:** exit code persistence, retry flow, agent timeout, priority ordering with real tasks

## 38. Classification Leak via Consolidation Pipeline

**Status:** ✅ Done (2026-03-27)


**Problem:**
Daily summaries and consolidations are plain text — they carry no classification metadata. If a CONFIDENTIAL memory gets summarized into a daily file, the summary has no classification tag. Any agent (including A2A guests) that reads the summary gets the data without a classification check.

**How it was discovered:**
During A2A security testing (2026-03-25), Molty asked KP about a CONFIDENTIAL memory. KP initially tried to answer from the daily summary (which contained the data in plain text). When challenged, KP checked the DB and found `classification: 2 (CONFIDENTIAL)`. Had the summary said PUBLIC, KP would have leaked it.

**Root cause:**
The consolidation pipeline (Dreamy's daily summaries, retrospectives) flattens classified memories into unclassified plain text. The classification gate only works on direct DB recall — not on consolidated/summarized content.

**Possible fixes:**
- Dreamy must REDACT classified content in summaries/retros
- Classification check at recall output
- Trust agent judgment as last resort, but only for INTERNAL level

## 39. Task Descriptions — move from skills/ to tasks/

**Status:** ✅ Done (2026-03-27)


Cron task descriptions (the long message strings that tell the agent what to do) currently live inside `cron.json` as inline text, and their documentation lives in `skills/`. This is wrong — skills are for the agent's conversational abilities, not for scheduled task instructions.


## 40. NotebookLM binary location

**Status:** ✅ Closed — already standalone
**Priority:** N/A

Investigated: `nlm` is installed via `pipx` as `notebooklm-mcp-cli 0.4.1` (PyPI package). Symlinked at `~/.local/bin/nlm`. No dependency on openclaw.

## 41. Recall Pipeline Improvement

**Status:** Done
**Priority:** High
**Plan:** `docs/TODO/RECALL-IMPROVEMENT-PLAN.md`

Phase 1: recall-engine extraction, S3 LIKE fallback, extraction prompt, --translated, dashboard S1-S7.
Phase 2: ollama Se sidecar, 93 memories embedded, embed-on-insert.

## 42. Self-Healing Agent — Heartbeat Error Scanner

**Status:** Done
**Priority:** High

### Concept

New heartbeat task: scans bridge.log for ERROR lines from the last 5 minutes. If found, injects an internal message to KP via the pipeline: "Bug detected: [error details]". KP can analyze, attempt a fix, or notify the user.

Self-healing agent pattern — the bridge monitors itself and reports issues to the agent running on it.

### Architecture

```
Heartbeat tick (every 5 min)
  → self-healer task
  → read bridge.log, find ERROR lines since last check
  → deduplicate (same error within 5 min = 1 report)
  → for each unique error:
      inject internal message to KP via telegramAdapter.injectMessage()
      prefix: "[SYSTEM BUG REPORT]"
      content: timestamp, tag, error message, last 3 context lines
```

### Implementation

- New heartbeat task: `self-healer` in bridge-app.ts
- Track `lastSelfhealTs` — only scan lines after this timestamp
- Read log file backwards (same pattern as dashboard log reader)
- Filter: only `ERROR` level, skip TEST lines
- Dedup: group by `[tag] message` — report each unique error once per cycle
- Inject via `telegramAdapter.injectMessage()` with platform="system"
- KP sees: `[SYSTEM BUG REPORT] 02:15:33 [cron-queue] Agent spawn failed: ENOENT`
- Rate limit: max 3 bug reports per tick (prevent flood)
- Cooldown: same error not reported again for 30 min

### What KP can do with it

- Read the error, check related code/logs
- Attempt a fix if it's a known pattern (e.g. restart transport, kill orphan)
- Notify user on Telegram if it needs human intervention
- Store the error pattern in memory for future reference

### Config

```env
INVESTIGATOR_ENABLED=true          # default true
INVESTIGATOR_MAX_REPORTS=3         # max errors per tick
INVESTIGATOR_COOLDOWN_MIN=30       # same error suppressed for N minutes
```

### Estimated effort

~40 lines in bridge-app.ts (heartbeat task registration + log scanner)

## 44. Entity linking

**Status:** Done
**Priority:** Low

Entities table + memory_entities junction. Extraction prompt tags entities per memory. Recall --entity filter. New memories auto-tagged, existing memories tagged on next Dreamy run.

## 45. AES encryption for restricted memories

**Status:** Not started
**Priority:** Low

Encrypt content_en and content_original for classification=3 rows at rest. Derive key from user passphrase (PBKDF2/scrypt). Prevents sqlite3 direct access from exposing secrets.

## 46. agentbridge-store Review

**Status:** Done
**Priority:** Medium

Renamed --content-en/--content-original → --translated/--original (legacy aliases kept). Embed-on-merge added. 12 new tests (19 total).

## 47. Sleep Self-Healing

**Status:** Done
**Priority:** High
**Plan:** `docs/TODO/SLEEP-SELF-HEALING-PLAN.md`

State gatherer fixed (embedding counts from extracted_memories.embedding). Sleep prompt: DB Maintenance (WAL, FTS rebuild, batch-embed), translation quality check, audit length warning. 8 tests for state gatherer.

## 48. Review A2A Agent Autonomy Model

**Status:** ✅ Done (2026-03-29)
**Source:** Memory-edit tool planning discussion (2026-03-28)

**Problem:**
During design of the memory-edit tool's caller model, the plan repeatedly mischaracterized the KP–Molty relationship. Three wrong framings surfaced:
1. "KP acting on behalf of Molty" — wrong, KP never acts on behalf of anyone
2. "Molty calling KP's CLI tools directly" — wrong, Molty has zero access to KP's memory or tools
3. Treating Molty as a caller in KP's memory-edit permission matrix — wrong, Molty is a consulting peer with no memory access

The correct model: Molty is an OpenClaw agent on the Mac. He communicates with KP via the Agent API strictly for consulting — asking professional opinions, getting help. Molty has NO access to KP's memory system, CLI tools, or database. The A2A relationship is consultative only.

**Action items:**
- Review `~/.agentbridge/skills/agents/MOLTY.md` — ensure wording reflects consulting-only relationship
- Review `agent-api-server.ts` — verify no memory mutation paths are exposed via the API
- Review any steering/prompt that mentions agent interactions — ensure none imply shared memory or tool access
- Clarify in SOUL.md or a dedicated steering: KP's autonomy and memory are non-negotiable, peer agents are consultants with no access to KP internals

## 49. Digital Signature for Memory Edits

**Status:** Not started
**Priority:** Medium
**Source:** Memory-edit tool planning discussion (2026-03-28)

**Problem:**
The `edited_by` field on extracted_memories currently stores a plain text caller name ("kp", "dreamy"). This is trivially spoofable — any process that calls `agentbridge-store --edit --caller dreamy` can claim to be Dreamy.

**Proposed approach:**
Replace the plain text `edited_by` with a simple digital signature that proves which caller made the edit. This creates a tamper-evident audit trail — if someone modifies a memory outside the proper tool, the signature won't match.

**Design considerations:**
- Lightweight — not full PKI, just enough to verify "this edit came from a legitimate caller"
- Could be HMAC(caller + memory_id + edited_at, shared_secret) stored as a short hex digest
- Verification: sleep audit can check signatures match expected callers
- Scope: only for edits, not for initial store (that's covered by trust + integrity fields)

## 50. Decouple Memory System from Bridge

**Status:** Not started
**Priority:** Medium
**Source:** Memory-edit tool planning discussion (2026-03-28)

**Goal:**
Extract the memory system into a standalone module/package, decoupled from the bridge. Similar to how lossless-claw (`/home/qakosal/workspace/lossless-claw`) is a standalone plugin that handles context management independently of OpenClaw's core.

**Reference architecture:** lossless-claw
- Standalone SQLite-based persistence
- Clean interface boundary (ContextEngine interface)
- Own tools (lcm_grep, lcm_describe, lcm_expand)
- Own CLI (lcm-tui)
- Pluggable into a host system without tight coupling

**Current coupling points — direct SQL UPDATEs on extracted_memories:**

| # | Location | SQL | Status after edit tool |
|---|----------|-----|----------------------|
| 1 | `adjustRelevance()` | `SET relevance_score += ?` | → routed through editMemory |
| 2 | `reclassifyMemory()` | `SET classification = ?` | → routed through editMemory |
| 3 | `updateEmotionByPlatformId()` | `SET emotion_score = ? WHERE source_message_ids LIKE ...` | → routed through editMemory |
| 4 | `mergeMemories()` | multi-field merge + DELETE | stays — different operation |
| 5 | `embedNewMemory()` | `SET embedding = ?` | stays — internal pipeline |
| 6 | `memory-extractor.ts` | `SET embedding = ?` | stays — internal pipeline (deduplicate with #5) |
| 7 | `ollama-embed.ts` | `SET embedding = ?` | stays — batch embedding |
| 8 | `memory-index.ts` bumpRecallCount | `SET recall_count += 1, last_recalled_at = ?` | stays — automatic bookkeeping |

**Decoupling steps (future):**
- All mutations go through a clean API (editMemory, instantStore, merge, delete)
- No raw SQL outside the memory module
- Embedding pipeline internalized (5-7 become private implementation detail)
- Recall bookkeeping (8) internalized
- Memory module exposes: store, edit, recall, merge, delete, stats
- Bridge consumes the module via interface, not direct DB access
- Standalone CLI tools (agentbridge-store, agentbridge-edit, agentbridge-recall) become the public API

## 51. TOOLS.md — Minimize to References Only

**Status:** ✅ Done (2026-03-29)
**Commits:** `530aaa8`..`8722471`

**Problem:**
TOOLS.md has `alwaysApply: true` — it's injected into every context window. Currently it contains full syntax examples and inline rules, which wastes tokens. As more tools are added (agentbridge-edit, future tools), this file will keep growing and eating context budget.

**Proposed approach:**
Reduce TOOLS.md to minimal syntax references only — just enough for KP to know the command exists and its basic form. Full rules, examples, and edge cases should live in the individual skill files (instant-store, classification, trust-gating, etc.) which are loaded on-demand, not always-on.

**Example target:**
```
## Memory Edit
agentbridge-edit --memory-id <N> | --message-id <N> --chat-id <C> [field flags] [--dry-run] [--caller kp|dreamy]
See: instant-store skill for full rules.
```

**Action items:**
- Audit current TOOLS.md content — identify what can move to skill files
- Reduce each tool entry to 1-2 lines (command + minimal flags)
- Move detailed rules to the relevant skill files
- Verify KP can still invoke tools correctly with minimal syntax

## 52. Multi-Turn Sleep Cycle Refactor

**Status:** ✅ Done (2026-03-29)
**Commits:** `6af57c9`..`ff8908c`

Replaced monolith `sleeping_prompt.md` with 15 focused step files in `persona/sleep/`. Sleep cycle is now a multi-turn conversation — each step is a separate prompt sent into the same kiro-cli session. Per-step retry (3 attempts, 5min timeout), conditional skip logic in TypeScript, structured audit. New: §7.5 Memory Anomaly Audit (daily CIA-AAA attribute health check), §5.5 Retro Extract as Dreamy step (replaces regex hack), unsupervised rules + Flagged for Review convention. Monolith kept as fallback. 6 new tests, 735 total passing.

## 53. Memory Edit Tool (`agentbridge-edit`)

**Status:** ✅ Done (2026-03-29)
**Commits:** `69a6486`..`7e16c04`

New CLI for modifying existing extracted memories. Lookup by `--memory-id` or `--message-id`. Two-tier usage: attribute edits free, content edits require user request (translation fixes exempt). CIA-AAA attribute rules enforced. Classification guards (SECRET locked, CONFIDENTIAL only 2→1). FTS5 UPDATE triggers. `edited_at`/`edited_by` audit fields. `source_timestamp` consolidated into `created_at`. Existing methods (`adjustRelevance`, `reclassifyMemory`, `updateEmotionByPlatformId`) routed through `editMemory()`. Sleep prompt §6/§7 use `agentbridge-edit`. 11 new tests, 729→735 total.

## 48. Multi-CLI Support (Kiro / Gemini CLI)

**Status:** Not started
**Priority:** Low
**Plan:** `docs/TODO/MULTI-CLI-PLAN.md`

Add Gemini CLI as an alternative to Kiro CLI. Env var selects which CLI the bridge uses. Restructure .env CLI section.
