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

**Status:** Partial — receiving done, sending + context issues unresolved
**Priority:** Medium
**Source:** OpenClaw media handling study (memory refactor), user request (2026-03-22)

**Done:**
- Telegram + Discord: photos/documents downloaded and saved to `~/.agentbridge/received/media/`
- File path appended to prompt (`File saved at: ...`) — KP can read images via kiro-cli tools
- Sleep §9.5 media cleanup (FIFO 100MB budget)

**Remaining:**
- KP cannot send images back to the user (no `sendPhoto` / `sendImage` on adapters)

**Context window problem (2026-03-31):**
kiro-cli reads images as a tool call (file read → base64 text into context). A 233KB JPEG = ~100K tokens — fills most of minimax-m2.5's 128K context. On retry, the image loads again, tripling the damage. Result: `-32603 ValidationException` after 3 retries, session dead.

**Mitigation options:**
1. **Downscale images** — resize to 512px max before saving. Drops ~20K tokens. Quick win.
2. **Skip image forwarding** — tell agent "user sent an image" without file path. Agent asks if needed.
3. **Native vision model** — Sonnet/GPT-4o handle images as image blocks, not base64 text. No context bloat.
4. **Auto-reset on image fail** — if image read causes -32603, reset session and reply "image too large for current model".

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

## 48. Multi-CLI Support (Kiro / Gemini CLI / Cloud9)

**Status:** Planning
**Priority:** Low
**Plan:** `docs/TODO/MULTI-CLI-PLAN.md`

Phase 1: Abstract CLI spawn + env restructure (AGENT_CLI, AGENT_TRANSPORT, AGENT_MODEL).
Phase 2: Gemini CLI — wire `gemini --experimental-acp`, test, document.
Phase 3: Cloud9 CLI — separate project, plugs in as `AGENT_CLI=cloud9`.

## 51. Cloud9 — Free LLM Transport (separate project)

**Status:** Not started
**Priority:** Low

Standalone MITM proxy + ACP CLI that provides free access to Google Cloud Code Assist (Gemini 2.5 Pro). Separate repo, plugs into AgentBridge as `AGENT_CLI=cloud9`. Replaces Molty/OpenClaw on Mac when ready. Based on 9Router's approach (MIT license, open source).

## 49. Cohere STT/TTS Integration

**Status:** ⏸ Postponed — no Hungarian support
**Priority:** Medium

Cohere Transcribe supports 14 languages (EN, DE, FR, IT, ES, PT, EL, NL, PL, VI, ZH, AR, JA, KO). No Hungarian — unusable for Molty's Hunglish conversations. Revisit if they add Hungarian. No TTS offering either — Edge TTS stays.

## 55. TTS Language Switching

**Status:** ✅ Done (2026-03-31)
**Commit:** `37081cf`

Agent prefixes voice replies with `[lang:hu]` or `[lang:en]`. Bridge picks matching Edge TTS voice (`hu-HU-TamasNeural` for Hungarian, `en-US-AndrewMultilingualNeural` for English). Tag stripped from display. SOUL updated with instruction.

## 50. 9Router Study

**Status:** Done (study complete)
**Priority:** Medium
**Related:** #48 (Multi-CLI / Gemini CLI)
**Study:** `docs/TODO/9ROUTER-STUDY.md`

### What is 9Router

Open-source local proxy (npm package) that routes AI requests to 40+ providers with smart fallback. Runs on `localhost:20128`. Self-hosted middleware, not a cloud service.

### Free tiers it aggregates

| Provider | Models | Free tier |
|----------|--------|-----------|
| iFlow | Kimi K2, Qwen3 Coder, GLM-4.7, MiniMax M2, DeepSeek R1 | Free |
| Qwen direct | Qwen3 Coder Plus/Flash | Free |
| Kiro/AWS Builder ID | Claude Sonnet 4.5, Haiku 4.5 | Free (via AWS Builder ID, can be revoked) |
| Gemini CLI | Gemini 3 Flash, 2.5 Pro | 180K completions/month free |

### Relevance to #48

If Gemini CLI routes through 9Router, we get Gemini 2.5 Pro free at 180K completions/month. Combined with `AGENT_CLI=gemini`, this could make the bridge essentially free to run.

### Study questions

1. How does 9Router integrate with Gemini CLI? Does it replace the API endpoint?
2. Can it be used as a drop-in for `AGENT_MODEL` routing?
3. Stability/reliability of free tiers — are they rate-limited?
4. Can AgentBridge use 9Router as a proxy for all LLM calls (main agent + subagents)?

## 54. Reliable SOUL & Core-Facts Injection (Cross-Model)

**Status:** Not started — study phase
**Priority:** HIGH
**Source:** Multi-CLI planning (#48), kiro free tier limitations, Gemini CLI support

### Problem

SOUL.md and all `alwaysApply: true` steering files are injected by kiro-cli's `.kiro/steering/` mechanism. This is kiro-specific. If the bridge switches to:
- **Kiro free tier** — steering may be limited or unavailable
- **Gemini CLI** — no `.kiro/steering/` support at all
- **9Router / other CLIs** — no steering mechanism

Without SOUL injection, KP loses identity, memory awareness, classification rules, and tool syntax. The agent becomes a generic chatbot.

### Current injection surface

| File | Size | Purpose | Always loaded? |
|------|------|---------|----------------|
| `SOUL.md` | 5.4KB | Identity, personality, continuity | Yes (alwaysApply) |
| `TOOLS.md` | 1.1KB | CLI tool syntax | Yes (alwaysApply) |
| `classification.md` | ~1KB | CIA-AAA rules | Yes (alwaysApply) |
| `trust-gating.md` | ~1KB | Trust/credibility rules | Yes (alwaysApply) |
| `instant-store.md` | ~1KB | Store/edit rules | Yes (alwaysApply) |
| 14 other steering files | ~15KB | Skills, tasks | On-demand |

Total always-on: ~10KB (~3K tokens). Total with all skills: ~25KB.

### Approaches to study

1. **System prompt injection** — bridge prepends SOUL + core steering to every user message as a system prompt block. Works with any LLM. Cost: tokens per message.

2. **First-message injection** — on session start, send SOUL as the first message before user content. Relies on context window persistence. Cheaper but fragile (context eviction).

3. **Hybrid** — compact SOUL (~2KB) always prepended, full skills loaded on-demand via tool descriptions or function calling metadata.

4. **Transport-level abstraction** — `IKiroTransport.sendPrompt()` gains a `systemContext` parameter. Each transport implementation handles injection differently:
   - kiro-cli: relies on steering (no change)
   - gemini-cli: prepends to prompt
   - raw API: system message field

5. **MCP tool descriptions** — encode SOUL/rules as tool descriptions that the model always sees. Hacky but works with any MCP-compatible client.

### Key constraints

- SOUL must survive context window compaction
- Classification rules are security-critical — must ALWAYS be present
- Token budget: free tiers have smaller context windows
- Must not break existing kiro-cli steering (backward compatible)

### Study tasks

- [ ] Measure kiro free tier context window and steering support
- [ ] Test Gemini CLI system prompt injection
- [ ] Prototype transport-level `systemContext` parameter
- [ ] Measure token cost of always-prepend vs first-message
- [ ] Test SOUL persistence across long conversations (does it get evicted?)

## Hot-reload skills via heartbeat

**Status:** ✅ Done (2026-03-31)
**Commit:** `c6dce40`

### Plan

1. **New file:** `src/components/skill-watcher.ts`
   - `SkillWatcher` class, constructed with skills dir path
   - `checkForChanges(): NewSkill[]` — stats all `*.md` in skills dir (recursive), compares mtime against stored map, returns new/changed files
   - Returns `{ filename, name, description }` — parses first heading + first paragraph from the .md
   - Stores `Map<filename, mtimeMs>` in memory (full scan on first tick, skip first tick since skills already loaded)

2. **Heartbeat task:** register `skill-reloader` in `bridge-app.ts` heartbeat tasks
   - Calls `skillWatcher.checkForChanges()`
   - For each new skill: inject short notification into ACP session: `[NEW SKILL AVAILABLE] <name>: <description>. Read ~/.agentbridge/skills/<filename> if you need it.`
   - Append a 1-liner to `~/.agentbridge/skills/TOOLS.md` tool list: `- <name>: <description>`
   - Log: `[skill-reloader] New skill available: <name>`

3. **No full injection** — agent reads the skill file on demand via `cat` when it needs it or user asks

4. **No delete handling** — removed skills don't need hot-reload, handled on next restart



## Multi-user Telegram support

**Status:** Not started
**Priority:** high
**Effort:** medium

Bridge should be able to send messages to Telegram chats other than the current user's. Required for:
- Proactive messages to other users (e.g. daily riddle to Adrika)
- Notifications to group chats
- Agent-initiated outreach

Implementation: expose `bot.sendMessage(chatId, text)` as an agent-callable tool or CLI (`agentbridge-send --chat-id <id> --message <text>`). The Telegram adapter already has the bot instance — just needs a send path that doesn't require an inbound message context.

## 9Router integration

**Status:** Not started
**Priority:** medium
**Effort:** small

9Router is installed on the Mac (`localhost:20128`) and registered as an OpenClaw provider. Wire it into agentbridge as an alternative model provider — route requests through 9Router's OpenAI-compatible API to access free models (Kiro/AWS Claude, iFlow, Qwen direct). Already audited for security (see `docs/9ROUTER-SECURITY-AUDIT.md`). Don't enable MITM or tunnel features.

## Faster partial response delivery

**Status:** ✅ Done (2026-03-31)
**Commits:** `861177c`, `877d29e`, `c863b3f`

ACP streaming via edit-in-place. Agent message chunks accumulated, Telegram message edited every 3s (configurable via `STREAM_FLUSH_SEC`, range 2-180, 0=disabled). Shows `▍` cursor while generating. `/stop` and `/ctrlc` bypass pipeline for immediate cancel. Poller made non-blocking so commands aren't queued behind long responses.

## OpenRouter provider support

**Status:** Not started
**Priority:** medium
**Effort:** medium

Add OpenRouter as a direct model provider for agentbridge — bypass kiro-cli and call OpenRouter API directly. Enables access to 100+ models (free and paid) without depending on kiro-cli's model availability. Use OpenAI-compatible `/v1/chat/completions` endpoint with `OPENROUTER_API_KEY`. Include app attribution headers (`HTTP-Referer`, `X-OpenRouter-Title`) for free tier eligibility.

## Monitor context window — log ctx% from ACP metadata

**Status:** ✅ Done (2026-03-31)
**Commits:** `ef8b3c9`..`0c6ce44`

ctx% logged on every ACP metadata event, prompt complete, inbound message, and outbound response. Auto-compact triggers at 85% (configurable via `MEMORY_COMPACT_THRESHOLD_PCT`). Fixed cast to work for AcpTransport (was TmuxClient-only).

## 56. Bridge Resilience Package

**Status:** ✅ Done (2026-04-01)
**Commit:** `90cbbbb`

Full self-healing and resilience system:

### Watchdog (heartbeat task)
- Tracks `promptStartedAt` / `lastSuccessAt` on AcpTransport
- Only triggers when a prompt is in-flight (no false positives on idle)
- Level 0 (stuck 1 cycle): `doctor.sh --fix` (once)
- Level 1 (stuck N cycles, `WATCHDOG_CYCLES` env, default 2): cancel + reset ACP session
- Level 2 (still stuck next tick): `process.exit(0)` → launchd restarts
- 1hr cooldown on full sequence to prevent loops

### Restart reason tracking
- `.last-restart-reason` file written by: auto-compact, watchdog L1/L2, user /reset, user /restart
- On session start: injected as `[SESSION START REASON]` so agent knows why previous session ended
- File deleted after read (one-shot)

### ACP auto-reinitialize
- kiro-cli child process `exit` event monitored
- On unexpected exit (code ≠ 0): auto-respawn in 5s
- Faster recovery than waiting for watchdog timeout

### DB integrity (hourly)
- Every 12 heartbeat ticks: `PRAGMA integrity_check` on memory.db
- Logs ERROR if failed

### Poller liveness
- `lastPollAt` tracked on Telegram poller (updated every successful poll cycle)
- Ready for watchdog integration (service registry access needed)

### /stop, /ctrlc, /restart
- All bypass the pipeline queue (work even when bridge is busy)
- `/restart`: `process.exit(0)` → launchd auto-restarts

### agentbridge-restart CLI
- Molty can self-restart via `agentbridge-restart "reason"`
- Writes flag file → heartbeat picks up → `process.exit(0)`

## 57. ACP Streaming — Edit-in-Place

**Status:** ✅ Done (2026-04-01)
**Commits:** `861177c`..`c863b3f`

Partial response delivery via Telegram `editMessageText`. ACP `agent_message_chunk` notifications accumulated in buffer, flushed every `STREAM_FLUSH_SEC` (default 3s, env configurable, range 2-180, 0=disabled). Shows `▍` cursor while generating. Final edit removes cursor. Falls back to normal delivery if no chunks arrived.

## 58. Self-Healer Hardening

**Status:** ✅ Done (2026-04-01)
**Commit:** `21042f7`

- Skip transient errors (-32603, fetch failed) — handled by retry logic
- Max 1 report per tick (was 3)
- 30min cooldown per error key unchanged

## 59. Auto-Reset on Context Overflow

**Status:** ✅ Done (2026-04-01)
**Commit:** `151a10b`

Pipeline error handler detects `ValidationException` or `-32603` after retries exhausted. Immediately resets ACP session, writes restart reason, tells user "Context window full — session reset." No watchdog wait needed.

## 60. Self-Healer Blacklist Filter

**Status:** ✅ Done (2026-04-01)
**Commit:** `10b433c`

Configurable blacklist array for self-healer log scanner. Skips: `-32603`, `Transient error`, `fetch failed`, `ECONNRESET`, `ETIMEDOUT`, `socket hang up`, `[self-healer]`, `[watchdog]`, `[db-integrity]`, `auto-approved`, `permission`. Fixed feedback loop where self-healer reported its own log lines as errors.

## 61. Message Queue + WAIT Interrupt

**Status:** ✅ Done (2026-04-01)
**Commit:** `a8655ff`

Messages arriving while a prompt is in-flight are queued (FIFO) instead of dropped. User sees `⏳ Queued (N)`. Queue drains one at a time after each prompt completes. Messages starting with "WAIT" (case-insensitive) cancel the current prompt and process immediately.

## 62. Telegram Reply Context

**Status:** ✅ Done (2026-04-01)
**Commit:** `28510b5`

When user replies to a message on Telegram, the quoted message text (up to 500 chars) is prepended to the prompt: `[Replying to name: "quoted text"]`. Agent sees what the user is replying to.

## 63. Move sleep startup into heartbeat cycle

**Priority:** high
**Effort:** small

Remove the special `shouldRunOnStartup()` sleep check from bridge startup. Let the heartbeat `sleep-trigger` task handle it — it already checks "should I run today?" every tick. Cleaner: one main process, one heartbeat loop, no extra startup logic. Also reduce `MIN_UPTIME_MS` from 3min to 1min — once-a-day tasks don't need 3min warmup.

## 64. STT gibberish detection + safe languages

**Status:** Not started
**Priority:** low
**Effort:** small

Whisper sometimes transcribes Hungarian voice notes as other languages (e.g. "ügyes vagy" → "видясь влаге" in Russian). Add `STT_SAFE_LANGUAGES` env var (default: `hu,en`). If transcription contains non-Latin/non-Hungarian script, flag as potential STT failure. SOUL adjustment: Molty should creatively recognize gibberish and ask user to repeat ("Nem értettem a hangüzenetet, megismétled?" instead of generic "Mi van?").

## 65. Recall time-decay scoring with emotion override

**Status:** Not started
**Priority:** medium
**Effort:** small

### Problem
All memories score equally regardless of age. A fact from 6 months ago ranks the same as yesterday's. Human memory doesn't work this way — recent memories are more accessible, but emotionally charged ones persist.

### Design

Apply time-decay + emotion boost to recall scoring in `recall-engine.ts`:

```
final_score = base_score * recency_factor * emotion_boost

recency_factor = max(0.3, 1 - (age_days / 365))
emotion_boost = 1 + (abs(emotion_score) * 0.1)
```

| Age | Emotion 0 | Emotion ±3 | Emotion ±5 |
|-----|-----------|------------|------------|
| 1 day | 1.0x | 1.3x | 1.5x |
| 30 days | 0.92x | 1.2x | 1.38x |
| 180 days | 0.51x | 0.66x | 0.76x |
| 365 days | 0.3x (floor) | 0.39x | 0.45x |

### Implementation
- Modify `addHit()` or the final scoring in `recallSearch()` in `recall-engine.ts`
- Read `created_at` and `emotion_score` from `extracted_memories` (already available in query results)
- Apply after base FTS5/embedding scoring, before MMR re-ranking
- Only affects S1-S3 (extracted_memories). S4-S5 (messages) already favor recent via timestamp ordering.

### Config
- `RECALL_DECAY_DAYS=365` — full decay period
- `RECALL_DECAY_FLOOR=0.3` — minimum weight for oldest memories
- `RECALL_EMOTION_BOOST=0.1` — boost per emotion point

## 66. In-process memory CLI interception

**Status:** Not started
**Priority:** high
**Effort:** medium

### Problem
`agentbridge-store` and `agentbridge-recall` are CLI tools. Every call spawns a new node process → full DB init → embeddings init → execute → close. During conversation, Molty may store 5-10 memories — that's 5-10 cold starts. During sleep extraction, the model calls `agentbridge-store` per memory — same overhead.

### Current flow
```
Molty → bash tool call → kiro-cli spawns node process → agentbridge-store CLI
  → new MemoryManager → open DB → init embeddings → store → close → exit
```

### Proposed flow
```
Molty → bash tool call → kiro-cli permission handler (bridge intercepts)
  → parse args → call bridge's in-process MemoryManager.instantStore()
  → return result to kiro-cli → no subprocess spawned
```

### Design

**Permission handler interception:**
- ACP transport's `onPermissionRequest` already sees every tool call with title + command
- Match commands starting with `agentbridge-store`, `agentbridge-recall`, or `agentbridge-edit`
- Parse CLI args from the command string
- Route to in-process MemoryManager methods
- Return the result as tool output
- Auto-approve (no permission prompt needed)

**For main bridge (conversation):**
- Bridge has MemoryManager in-process, DB already open
- Permission handler has access to it via closure
- `agentbridge-store` → `memory.instantStore(parsedArgs)`
- `agentbridge-recall` → `recallSearch(parsedArgs)` → format output
- `agentbridge-edit` → `memory.editMemory(parsedArgs)` — emotion harvest, classification changes, darwinism edits

**For sleep process:**
- Sleep already has `db` open (for daily summary)
- Create a lightweight MemoryManager in the sleep process
- Keep it alive across all steps (don't close between steps)
- Extraction step calls `instantStore()` directly instead of bash
- No ACP interception needed — code-driven step calls it in-process

**Arg parsing:**
- Reuse existing CLI arg parsing from `agentbridge-store.ts` and `agentbridge-recall.ts`
- Extract into shared `parseStoreArgs()` and `parseRecallArgs()` functions
- Both CLI entry point and interception handler use the same parser

### Benefits
- ~500ms per store/recall instead of ~3-5s (no cold start)
- No orphan node processes
- No duplicate DB connections
- Embeddings reused (already loaded in bridge)
- Sleep extraction much faster (10 stores = 5s instead of 30-50s)

### Migration
- CLI tools still work standalone (for manual use, doctor.sh, etc.)
- Interception is transparent — agent doesn't know the difference
- Fallback: if interception fails, let kiro-cli spawn the CLI as before

### Implementation steps
1. Extract arg parsers from `agentbridge-store.ts`, `agentbridge-recall.ts`, `agentbridge-edit.ts` into shared modules
2. Add interception logic to ACP permission handler in `bridge-app.ts` — match all three CLIs
3. For sleep: keep MemoryManager alive across steps, pass to extraction + emotion harvest + darwinism
4. Conversation emotion harvest: `agentbridge-edit --emotion-score` intercepted in-process — no subprocess for reaction-triggered edits
5. Test: verify store/recall/edit work both via interception and standalone CLI
