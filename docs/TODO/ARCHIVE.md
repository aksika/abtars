# Backlog Archive — Completed Items

> 17 items completed. Moved from BACKLOG.md.

## 91. ABM — AgentBridge Memory System

**Priority:** HIGH
**Status:** ✅ Done (2026-04-11) — Phase 0-2 complete, Phase 3 tracked as #125/#126
**Roadmap:** [abm-roadmap.md](../specs/abm-roadmap.md)
**Specs:** [memory-v2-tiered.plan.md](../specs/memory-v2-tiered.plan.md), [memory-decoupling.plan.md](../specs/memory-decoupling.plan.md), [mempalace-study.md](../specs/mempalace-study.md)

### Phase 0: Decouple → #123 ✅

### Phase 1: ABM v1 — Tiered Memory ✅
All implemented: topic column + index, tier (core/general) with auto-promote on |emotion| >= 4, Dreamy promotion candidates in sleep, temporal validity (valid_from/valid_to), recall filters expired, core files split (user_profile.md + agent_notes.md), --topic/--tier on CLI.

### Phase 2: ABM v2 — MemPalace Enhancements
- ✅ Emotion tagger (2.1), importance flags (2.2), emotional arcs (2.3), compressor (2.4), dynamic wake-up (2.6), cross-topic timelines (2.7)
- ✅ Brain patterns: effectiveConfidence, isFlashbulb, detectInterference — all wired
- ✅ D5 Embedding tiering — separate table + int8 quantize
- ✅ 2.5 Contradiction checker — wired into sleep core promotion (2026-04-11)
- 🗑️ D3 ABM-L aware merge — **obsolete**, signature-based merge candidates already solve this
- 🅿️ ABM-L Compression Level 2 (entity header + topic grouping) — parked, 2% context usage on 1M models
- 🅿️ #96 ABM-L Rules v2 (entity whitelist, negation) — parked, filler bug fixed, rest is nice-to-have

### Phase 3: Universal Access → #124, #125, #126
Tracked separately. Unified CLI (#124), MCP server (#125), OpenClaw plugin (#126).

## 92. Review Dead Code — migration versions in memory-db.ts

**Priority:** LOW
**Status:** ✅ Done (2026-04-11) — collapsed 13 migrations into single fresh-install schema

Review whether old migration versions in `memory-db.ts` still need to be kept. Clean up any dead migration code that's no longer needed.

## 95. ABM Simplification

**Priority:** HIGH
**Status:** ✅ Done (2026-04-11)
**Spec:** [abm-simplification.md](../specs/abm-simplification.md)

Full-system review and simplification of the memory system. 7 items:
- ✅ #1 Recall pipeline: 10→4 stages, trigram FTS5, MMR reranking
- ✅ #2 ABM-L render layer + timelines: column dropped, render on read, 4 compression levels
- 🅿️ #3 CIA-AAA: parked
- ✅ #4 Sleep refactor: code pre-pass, 14 conditional prompts, candidate-driven skip, SLEEP_QUALITY tiering, dream report. All 9 tasks done.
- 🅿️ #5 IPC: parked
- ✅ #6 Dead schema: 2 columns dropped, effectiveConfidence wired
- ✅ #7 Emotion: tags as source of truth, arcs, mirroring, emotional wake-up

## 105. Embedding tiering — separate table + int8 quantization

**Status:** ✅ Done (2026-04-11)
**Completed by:** memory_embeddings table created, int8 quantization wired in ageMemoryTiers()

## 106. ABM v2 wiring — connect planned features

**Status:** ✅ Done (2026-04-10)
**Completed by:** ABM Simplification #6 + #7 — effectiveConfidence wired into Darwinism, buildArc wired into sleep, emotion tags unified as source of truth, emotion_context added

**Priority:** HIGH
**Status:** Not started

1. Wire memory.env loading into bridge startup
2. Wire --full recall flag (return content_en when available, ABM-L when not)
3. Wire aging SQL into maintenance methods (NULL columns, pressure calculation)
4. Auto-promote |emotion_score| >= 4 to core tier on store
5. Wire source_type + last_recall_context into store/recall CLIs
6. Wire spaced repetition decay into Darwinism
7. Update ABM-L format hint for new compression rules

## 110. Keyboard-adjacent typo correction for recall

**Status:** ✅ Done (2026-04-09)
**Completed by:** ABM Simplification #1 — trigram FTS5 indexes handle typos, accents, and substrings natively

**Priority:** LOW
**Status:** Not started

Adjacent-key typos (QWERTZ: z↔y, s↔a, doubled/missed chars) could be handled by a keyboard-layout-aware correction layer before trigram search. E.g. "hogz" → "hogy", "eyg" → "egy". However: (1) every language has its own layout, (2) the substring fallback already catches most cases for longer words, (3) the agent translates to English before recall (SOUL fix) which bypasses Hungarian typos entirely, (4) Ss signatures catch semantic meaning regardless of spelling. Not worth the complexity unless short-word recall failures become a pattern.

## 111. Self-healer — Auto-fix + Notify Tiers

**Priority:** HIGH
**Status:** ✅ Done (Phases 1–5 shipped)

### Phase 1: Two-tier self-healer ✅ DONE
- Auto-fix tier: whitelisted patterns → inject bounded fix command (30min cooldown)
- Notify tier: everything else → TG notification with count (60min cooldown)
- Pre-restart filter: ignores errors before BRIDGE START marker
- No more context window flooding

### Phase 2: Auto-fix JSON (externalized whitelist)
- `persona/config/auto-fix.json` — single source of truth, no hardcoded list
- Self-healer loads JSON at startup. Missing/empty → all errors go to notify tier
- Deploy copies to `~/.agentbridge/config/` (KEPT if newer)
- Schema: `[{ pattern, instruction, cooldownMin, enabled }]`
- Per-rule `enabled: boolean` — disable without deleting (default: true)

### Phase 3: Auto-fix via coding subagent (isolated transport) — depends on #122
- Self-healer matches auto-fix pattern → spawns `createSubagentTransport("coding")`
- Sends instruction as one-shot prompt to isolated transport (main agent context untouched)
- Captures response, logs to `~/.agentbridge/logs/autofix-<date>.log`
- TG notification: "🔧 Auto-fix ran: [pattern] → [result summary]"
- Destroys transport after completion. 5min timeout (kill if stuck)
- If subagent transport fails to initialize → skip fix, fall back to notify tier

### Phase 4: Agent-editable + validation
- `agentbridge-autofix` CLI: list/add/remove rules
- Validation: pattern max 200 chars, instruction max 500 chars, cooldownMin >= 5, no dupes
- Add to TOOLS.md so agent knows it exists
- `agentbridge-autofix test --pattern "FTS index"` — dry-run: shows matching log lines without running the fix
- Dreamy can suggest new rules during sleep retro

### Phase 5: Dreamy passive proposals
- Sleep retro step notes recurring errors + how they were resolved
- If same error fixed the same way 2+ times → Dreamy mentions it in the retro report
- "Recurring: [error] was fixed by [action] twice — consider adding as auto-fix rule"
- User reads retro, manually runs `agentbridge-autofix add` if they agree
- Dreamy never creates rules itself

**Files:** `self-healer.ts`, `agent-registry.ts`, `persona/config/auto-fix.json`, `src/cli/agentbridge-autofix.ts`, `deploy.sh`, `TOOLS.md`, sleep retro prompt

## 112. Unified Agent Registry

**Status:** ✅ Done (2026-04-10)
**Completed by:** ABM Simplification — createAgentTransport() factory, 5 callers replaced

**Status:** Not started
**Priority:** High
**Source:** ABM Simplification #4 (moved from sleep refactor — benefits all agents)

Single `createAgentTransport(role, config)` factory for all agent roles (professor/dreamy/browsie/coding). Each role has a universal agent config: persona (SOUL), rules, model preference, available tools, trust level. Bridge-injected context — NOT kiro steering files, NOT CLI-specific. Transport-agnostic (kiro-cli ACP, gemini-cli, direct API). Replaces 5 scattered `new AcpTransport()` calls across bridge-app, agentbridge-sleep, coding-mode, cron-queue, agent-api-server.

## 114. Weekly Timeline from Dailies

**Status:** ✅ Done (2026-04-10)
**Completed by:** ABM Simplification #2b — compress 7 dailies into 1 narrative timeline in wake-up

**Status:** Not started
**Priority:** Medium
**Source:** ABM Simplification #2b nice-to-have

Compress a week of daily summaries into one narrative timeline instead of loading 7 separate daily files. ~100 tokens instead of ~560. Reuse `buildTimelines()` on daily summary content. Each daily becomes a "memory" with date as created_at, extract key events + emotions. Render as single timeline in wake-up.

## 115. L0 Signal Level — Memory Tag Cloud

**Status:** ✅ Done (2026-04-10)
**Completed by:** ABM Simplification #2b — tag cloud for <100 token budget models

**Status:** Not started
**Priority:** Medium
**Source:** ABM Simplification #2b nice-to-have

For tiny models (<500 token budget), render ALL memories as a structured tag cloud: topics, entity counts, memory type distribution. ~50 tokens. Agent sees its entire memory as a structured overview. Enables "what do I know about X?" meta-queries. Add as new level in `pickLevel()`.

## 116. Cross-Topic Timelines

**Status:** ✅ Done (2026-04-10)
**Completed by:** ABM Simplification #2b — entities tracked across topic boundaries (XTL format)

**Status:** Not started
**Priority:** Medium
**Source:** ABM Simplification #2b nice-to-have

Follow an entity across topic boundaries. Currently timelines are per-topic. But "@clerk" appears in coding, work, and finance. Cross-topic timeline shows the full entity story with topic prefixes. Second pass in `buildTimelines()` grouping by entity only for entities in 3+ topics.

## 118. Model Health Check + Subagent Fallback

**Priority:** HIGH
**Status:** ✅ Done (2026-04-11)

**Problem:** If a subagent model (sleep, browse, coding) is misconfigured or unavailable (404, 429), the subagent burns through all retries and fails completely. We hit this with `nemotron-3:cloud` (wrong name → 404 × 18 attempts) and `qwen3-coder-next` (not available → "all models exhausted").

**Solution:**
1. Startup health check: verify all configured models respond (lightweight ping, not full prompt)
2. Runtime fallback: if a subagent model returns 404/429, fall back to the main agent model
3. Log clearly which model was unavailable and what it fell back to

**Affected models:** `AGENT_SLEEP_MODEL`, `AGENT_BROWSE_MODEL`, `AGENT_CODING_MODEL`

## 120. Replace .processed.json with file rename in retro-extract

**Priority:** MEDIUM
**Status:** ✅ Done (2026-04-11)

**Problem:** `retro-extract` tracks processed retrospective files via a separate `.processed.json` in the retro directory. This is an extra state file to manage.

**Solution:** Rename processed retro files to `<name>.done` (or `.old`) after extraction. The extract step globs for `retro_*.md` — renamed files won't match. No JSON tracking needed, filesystem is the state.

**Files:** `src/cli/agentbridge-retro-extract.ts`

## 121. Request Collision — Idle Gate for Smart Crons + Ollama Parallel

**Priority:** HIGH
**Status:** ✅ Done (2026-04-11)

**Problem:** Ollama processes one request at a time. Cron agent tasks (tweet, AI news) hit the same endpoint while user is chatting → 2+ minute hangs. User had to /stop to unblock.

### Solution

**Part 1: Idle gate for smart crons (code change)**

Cron agent tasks only launch when user is idle for 60s+.

- Bridge writes `lastPromptAt` timestamp to `bridge.lock` after each user prompt completes
- `cron-queue.ts` checks before launching agent-type tasks: `Date.now() - lastPromptAt > 60_000`
- If not idle → defer to next heartbeat tick (5 min later), job stays in queue
- Script-type crons (backup.sh) bypass the check — they don't hit LLM
- `lastPromptAt` missing or unreadable → treat as idle, run

**Part 2: OLLAMA_NUM_PARALLEL (config only, zero code)**

Set `OLLAMA_NUM_PARALLEL=2` on Ollama server. Allows 2 concurrent requests on same instance. Covers edge cases where sleep/browse overlaps with user chat despite idle gate.

- Mac: `launchctl setenv OLLAMA_NUM_PARALLEL 2` or add to Ollama plist
- Document in transport profile example

**Files:** `bridge-app.ts` (write lastPromptAt), `bridge-lock-transport.ts` (read helper), `cron-queue.ts` (idle check), `message-pipeline.ts` (write after prompt)

## 122. Unified Subagent Transport Factory

**Priority:** HIGH
**Status:** ✅ Done (2026-04-11)

**Problem:** 4 subagents (sleep, browse, coding, cron) each have their own transport creation logic — 70+ lines of duplicated code reading bridge.lock, creating DirectApiTransport or AcpTransport, wiring fallbacks. If the logic changes, it must change in 4 places.

**Solution:** Single `createSubagentTransport(role)` factory in `agent-registry.ts`.

**Key design decisions:**
1. Always check `readBridgeLockTransport()` first, regardless of config. If main agent fell back from ACP to Direct API at runtime, subagents follow. Config is the starting point, bridge.lock is the truth.
2. Read `maxContext` / `maxOutput` / `maxTurns` from env once in the factory — all callers use the same vars.
3. Always log transport init (no verbose flag) — it's a one-time init per session.
4. Return type is `IKiroTransport` — callers don't need to know the concrete type.
5. Wire per-agent context windows: `AGENT_SLEEP_CTX_WINDOW` for sleep, `AGENT_BROWSE_CTX_WINDOW` for browse, `AGENT_CODING_CTX_WINDOW` for coding, `AGENT_MAIN_CTX_WINDOW` for cron. Falls back to `API_DEFAULT_CONTEXT` (128000, set in .env).

**Role model table:**
| Role | Model source | Fallback |
|---|---|---|
| sleep | `AGENT_SLEEP_MODEL` | main model |
| browse | `AGENT_BROWSE_MODEL` | main model |
| coding | `AGENT_CODING_MODEL` | main model |
| cron | main model directly | none |

**Files:** `agent-registry.ts` (new function), `agentbridge-sleep.ts`, `cron-queue.ts`, `agent-api-server.ts`, `coding-mode.ts` (all simplified to one-liner)

## 123. Memory Decoupling — Extract @agentbridge/memory

**Priority:** HIGH
**Status:** ✅ Done (2026-04-11)
**Spec:** [memory-decoupling.plan.md](../specs/memory-decoupling.plan.md), [123-memory-decoupling.md](../specs/123-memory-decoupling.md)
**Prerequisite for:** #124, #125, #126

Extract the memory system into a standalone `@agentbridge/memory` package. The bridge imports it as a dependency. Zero bridge imports in memory code.

**Sub-phases (from spec):**
- 0.1: Internalize bridge utilities (logger, env-utils, paths) into memory package
- 0.2: Eliminate DB leaks — replace `getDatabase()` with proper interface methods
- 0.3: Define `IMemorySystem` interface
- 0.4: Remove HeartbeatSystem coupling — `IHeartbeat` interface
- 0.6: Decouple sleep from memory — maintenance methods on interface
- Package extraction: monorepo workspace, `@agentbridge/memory` builds independently

**Done already:** Phase 0.5 (types in `mem-types.ts`, `index.ts` entry point, 27 files in `src/memory/`)

## 124. Universal Memory CLI — `abmind`

**Priority:** MEDIUM
**Status:** ✅ Done (2026-04-11)
**Depends on:** #123
**npm:** `abmind` registered (0.0.1 placeholder)

Unified `abmind` CLI with subcommands: `store`, `recall`, `edit`, `search`, `status`, `embed`, `wake-up`. Works standalone without the bridge running. Replaces individual CLIs (`agentbridge-recall`, `agentbridge-store`, `agentbridge-edit`, `agentbridge-expand`, `agentbridge-embed`). Old CLIs deleted, all callers updated (sleep prompts, TOOLS.md, SOUL.md, deploy).

