# Backlog

> ⚠️ **Never delete items from this log.** Completed, cancelled, and closed items stay — they are historical record.

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

## 45. AES encryption for restricted memories

**Status:** Not started
**Priority:** Low

Encrypt content_en and content_original for classification=3 rows at rest. Derive key from user passphrase (PBKDF2/scrypt). Prevents sqlite3 direct access from exposing secrets.

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

## 64. STT gibberish detection + safe languages

**Status:** Not started
**Priority:** low
**Effort:** small

Whisper sometimes transcribes Hungarian voice notes as other languages (e.g. "ügyes vagy" → "видясь влаге" in Russian). Add `STT_SAFE_LANGUAGES` env var (default: `hu,en`). If transcription contains non-Latin/non-Hungarian script, flag as potential STT failure. SOUL adjustment: Molty should creatively recognize gibberish and ask user to repeat ("Nem értettem a hangüzenetet, megismétled?" instead of generic "Mi van?").

## 67. Multi-user Telegram support

**Priority:** high
**Status:** Not started
**Effort:** medium

Support multiple Telegram users with separate sessions. Currently `ALLOWED_USER_IDS` accepts multiple IDs but all share the same kiro-cli session. Need per-user session isolation, separate memory contexts, and `agentbridge-send` CLI for programmatic message injection.

## 68. Picture context bloat mitigations

**Priority:** medium
**Status:** Not started
**Effort:** medium

Images sent via Telegram consume large context window chunks. Mitigations: auto-resize/compress before sending to model, strip image data from message history after processing, configurable max image size, skip images when context is above threshold.

## 77. Agent Sandbox — Restrict File/Command Access

**Priority:** HIGH
**Status:** Not started

### Problem
Agent modified source code in `~/agentbridge/` (developer repo) without permission. Agent notes say "don't modify code" but the agent ignored it. Notes are advisory — the agent can bypass them. Need enforcement, not guidance.

### Deployment Modes
`AGENT_SANDBOX=default|sandbox` env var controls permission enforcement:
- `default` — current behavior, no restrictions (what we have today)
- `sandbox` — permission handler enforces file/command blocklist

### Scope
Restrict what the agent can read, write, and execute. The agent should only operate within its designated workspace.

### Design Options

**Option A: Permission handler allowlist/blocklist**
- ACP transport's auto-approve logic checks paths before approving
- Blocklist: `~/agentbridge/`, `~/.ssh/`, `~/.aws/`, etc.
- Allowlist: `~/.agentbridge/`, `/tmp/`, `~/.agentbridge/workspace/`
- Write operations: only allowlist paths
- Read operations: allowlist + selective read-only paths (e.g. can read `~/agentbridge/docs/` but not write)
- Pros: simple, in our control, no OS-level changes
- Cons: only works for ACP transport (tool calls), agent could use bash to bypass

**Option B: OS-level sandbox (macOS sandbox-exec / Linux namespaces)**
- Run kiro-cli inside a sandbox profile that restricts filesystem access
- macOS: `sandbox-exec -f profile.sb kiro-cli acp`
- Linux: `unshare` / `firejail` / AppArmor profile
- Pros: enforced at OS level, can't bypass from inside
- Cons: complex, platform-specific, may break kiro-cli functionality

**Option C: Dedicated user + filesystem permissions**
- Run the agent as a separate OS user (e.g. `molty`)
- `~/.agentbridge/` owned by `molty`, `~/agentbridge/` owned by `akos`
- Agent literally can't write to developer repo
- Pros: simple, battle-tested, cross-platform
- Cons: complicates deployment, needs sudo for setup

**Option D: Hybrid — Permission handler (quick) + OS sandbox (later)**
- Phase 1: Implement Option A (permission handler blocklist) — immediate protection
- Phase 2: Add Option B or C for defense-in-depth

### Recommendation
Option D (hybrid). Phase 1 is a code change in `acp-transport.ts` auto-approve logic — can ship today. Phase 2 is infrastructure work for later.

### Phase 1 — Permission handler sandbox
- In `acp-transport.ts`, before auto-approving a tool call:
  - Extract file path from tool description
  - Check against blocklist (reject) and allowlist (approve)
  - Blocked → reject with explanation message to agent
- Config: `SANDBOX_BLOCKED_PATHS`, `SANDBOX_ALLOWED_WRITE_PATHS` in `.env`
- Log all blocked attempts at WARN level

### Phase 2 — NemoClaw-style Docker isolation (from refactor #9)

**Context:** All refactor prerequisites are now complete — Bridge class, capability plugin system, pluggable memory backends, CLI IPC. The architectural seams exist to split bridge (host) from agent (sandbox).

**Architecture:**
```
Host (unsandboxed): Bridge core, memory, platforms, dashboard
  │ ACP over stdio (already exists)
Sandbox (Docker): kiro-cli, agent tools, browser
  - Network: deny-by-default egress, allow kiro API only
  - Filesystem: read-only except /sandbox
  - No access to .env, memory.db, bridge code
```

**Action items:**
- [ ] Dockerfile for agent sandbox (reference: NemoClaw's 4-layer defense)
- [ ] Network policy (allow kiro API endpoint, block internal network)
- [ ] Credential isolation (secrets stay on host, agent gets tokens via ACP)
- [ ] Filesystem policy (read-only system, writable /sandbox only)
- [ ] Update ACP transport to spawn inside container instead of locally

**Reference:** NemoClaw — Landlock LSM, seccomp filters, capability drops, gateway proxy.
**Effort:** High. **Risk:** Medium. **Depends on:** All refactor items (done).

## 79. ClawHub Skill Sync

**Priority:** HIGH
**Status:** Not started

Download community skills from ClawHub (clawhub.ai) into `~/.agentbridge/skills/clawhub/`. SkillWatcher already hot-reloads — just need a download CLI.

**Action items:**
- [ ] Research ClawHub API (endpoints, auth, skill format)
- [ ] Create `src/cli/agentbridge-clawhub.ts` with install/list/update/remove
- [ ] Add `/clawhub` command handler for agent-initiated installs
- [ ] Optional: heartbeat task for daily auto-update

**Effort:** Low-medium. **Risk:** Low.

## 81. Dual Browser Engine — Lightpanda + Patchright

**Priority:** HIGH
**Status:** Partial (2026-04-05, `refactor/architecture-v2` branch)

`BrowserManager` supports `patchright` and `lightpanda` engines. `BROWSER_ENGINE` env var + `--engine` CLI flag on both `agentbridge-browse` and `agentbridge-browser`. Lazy container management via `scripts/browser-lightpanda.sh`. `agentbridge-browser` defaults to lightpanda (fast scraping), `agentbridge-browse` defaults to patchright (stealth). `deploy.sh --full` pulls Lightpanda nightly.

### Remaining
- Container auto-stop: detect when no browse tasks have run for N minutes, stop idle containers. Both engines independently.

### Problem
Current browser uses Patchright (stealth Chromium) in Docker for all tasks. Heavy resource usage (~500MB RAM) for simple scraping that doesn't need stealth.

### Design
Two browser engines behind the same `agentbridge-browse` CLI:

| Engine | Use case | Technology | Container |
|--------|----------|------------|-----------|
| Lightpanda (default) | News, research, scraping, simple sites | Zig-based headless, CDP | `lightpanda/browser:nightly` |
| Patchright (fallback) | X.com, authenticated sites, bot-protected | Stealth Chromium fork | Existing Docker setup |

**Fallback strategy:** Agent tries Lightpanda first. If site breaks or bot detection triggered (empty content, "verify you're human" page), retry with `--engine patchright`.

**CLI:** `agentbridge-browse --task "..." --chat-id 123 [--engine lightpanda|patchright]`
Default engine: lightpanda. Skill instructs fallback pattern.

**Architecture:**
- Both engines expose CDP WebSocket endpoints
- `browser-manager.ts` connects to the selected engine's CDP endpoint
- `pending_browse.json` format unchanged — engine is transparent to browse-checker
- SSRF guard applies to both engines

**Action items:**
- [ ] Add Lightpanda Docker container management (start/stop alongside Patchright)
- [ ] Add `--engine` flag to `agentbridge-browse` CLI
- [ ] Update `browser-manager.ts` to connect via CDP endpoint (not launch Chromium directly)
- [ ] Update browse skill to instruct fallback pattern
- [ ] Test with common browse tasks (news sites, X.com)

**Effort:** Medium. **Risk:** Low (additive — Patchright stays as-is, Lightpanda is new option).

## 90. Skill: OpenRouter Free Tier Scout

**Priority:** MEDIUM
**Status:** Not started

### Problem
OpenRouter has dozens of free-tier models (`:free` suffix) with varying quality, context windows, and rate limits. Hard to know which ones are worth using without manually checking rankings and performance pages.

### Solution
Agent skill that searches OpenRouter for the best free-tier deals:
- Fetch model list via `GET /api/v1/models` — filter `:free` models
- Cross-reference with rankings: https://openrouter.ai/rankings
- Check per-model performance: https://openrouter.ai/{model}/performance
- Score by: context window, throughput, quality ranking, rate limits
- Output: ranked list of best free models for conversation, coding, and browsing tasks
- Agent can recommend model switches based on current task type

### Usage
User asks "what's the best free model right now?" → agent runs the skill, returns ranked recommendations.

## 91. ABM — AgentBridge Memory System

**Priority:** HIGH
**Status:** In progress
**Roadmap:** [abm-roadmap.md](../specs/abm-roadmap.md)
**Specs:** [memory-v2-tiered.plan.md](../specs/memory-v2-tiered.plan.md), [memory-decoupling.plan.md](../specs/memory-decoupling.plan.md), [mempalace-study.md](../specs/mempalace-study.md)

### Phase 0: Decouple → #123
Tracked separately. Extract `@agentbridge/memory` standalone package.

### Phase 1: ABM v1 — Tiered Memory
- Topic column on extracted_memories (34% retrieval boost per MemPalace benchmarks)
- Tier column (`core` vs `general`) — Dreamy promotes best to core during sleep, recall searches core first
- Temporal validity (`valid_from`/`valid_to`) — invalidate stale facts instead of deleting
- Core files restructure (core_facts.md + agent_notes.md split)
- Lower storage threshold — store more aggressively, Dreamy curates later

### Phase 2: ABM v2 — MemPalace Enhancements
- AAAK emotion scoring (40+ codes, keyword detection, arcs) + compression
- Contradiction detection on core promotion
- Dynamic wake-up from core tier (replaces static core-knowledge)
- Cross-topic linking (tunnels)

### Phase 3: Universal Access → #124, #125, #126
Tracked separately. Unified CLI (#124), MCP server (#125), OpenClaw plugin (#126).

## 92. Review Dead Code — migration versions in memory-db.ts

**Priority:** LOW

Review whether old migration versions in `memory-db.ts` still need to be kept. Clean up any dead migration code that's no longer needed.

## 93. Semantic Recall Cache

**Priority:** LOW
**Status:** Not started

In-memory cache for recall results within a session. If the agent queries the same (or semantically similar) keywords twice, return cached results instead of hitting SQLite + embeddings again. Simple `Map<string, SearchResult[]>` cleared on session reset. ~10 lines. No external dependency.

Inspired by Redis LangCache concept (O'Reilly "Managing Memory for AI Agents") but implemented as a trivial in-process cache.

## 96. ABM-L compressor quality fixes

**Status:** ✅ Done (2026-04-10)
**Completed by:** ABM Simplification #2 — filler bug fixed (stopped stripping meaningful verbs)

**Priority:** HIGH
**Status:** Not started

1. Primary flag from memory_type (D not F for decisions, L not CM for lessons)
2. Entity whitelist only (no @daily, @telegram, @high)
3. Preserve negations + pronouns in filler stripping
4. Topic inference from content when topic=general
5. No truncation limit — wake-up builder handles length
6. Pipe-separate list items, arrow cause→effect, abbreviations
7. Re-run backfill after fixes

## 103. ABM-L Compression Level 2 — wake-up rendering

**Status:** ✅ Done (2026-04-10)
**Completed by:** ABM Simplification #2 — ABM-L rendered on the fly, multi-resolution (signal/ultra/compact/full), timelines

**Priority:** HIGH
**Status:** Not started

Entity header + topic grouping + elide defaults in wake-up rendering. Daily summary compression to ABM-L. Compressed SOUL for <32K models. Adaptive full/compact/ultra based on context budget.

## 104. ABM-L storage optimization

**Status:** ✅ Done (2026-04-10)
**Completed by:** ABM Simplification #2 — content_compressed column dropped, ABM-L rendered on read from content_en

**Priority:** MEDIUM
**Status:** Not started

D2: Strip prefix from stored ABM-L, reconstruct from columns at render time. D3: ABM-L aware merge (duplicate detection on compressed content). FTS5 on content_compressed only (replace English FTS5).

## 105. Embedding tiering — separate table + int8 quantization

**Priority:** MEDIUM
**Status:** Not started

Move embeddings to memory_embeddings table. Quantize float32→int8 after 14 days (384 bytes vs 1536). int8 kept forever. Main table stays lean.

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


## 100. Zombie child process reaper

**Priority:** LOW
**Status:** Not started

Heartbeat task that checks known child refs (sleepHandle.child, browser pids). Reap dead ones, warn on accumulation. Low risk since daily restart cleans everything.

## 101. Offline detection — reduce retry noise

**Priority:** LOW
**Status:** Not started

Consecutive poller failure counter. After N failures, log "offline" once, reduce retry frequency. Reset on success. Prevents noisy logs when internet is down.

## 102. Disk space runtime check

**Priority:** LOW
**Status:** Not started

Heartbeat task checks `df` output. Warn at 90%, block new writes at 95%. Currently only checked during Dreamy sleep cycle.

## 110. Keyboard-adjacent typo correction for recall

**Status:** ✅ Done (2026-04-09)
**Completed by:** ABM Simplification #1 — trigram FTS5 indexes handle typos, accents, and substrings natively

**Priority:** LOW
**Status:** Not started

Adjacent-key typos (QWERTZ: z↔y, s↔a, doubled/missed chars) could be handled by a keyboard-layout-aware correction layer before trigram search. E.g. "hogz" → "hogy", "eyg" → "egy". However: (1) every language has its own layout, (2) the substring fallback already catches most cases for longer words, (3) the agent translates to English before recall (SOUL fix) which bypasses Hungarian typos entirely, (4) Ss signatures catch semantic meaning regardless of spelling. Not worth the complexity unless short-word recall failures become a pattern.

## 111. Self-healer — Auto-fix + Notify Tiers

**Priority:** HIGH
**Status:** Partly done (Phase 1 shipped: two-tier notify/auto-fix, pre-restart filter, occurrence count)

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

### Phase 3: Auto-fix via coding subagent (isolated transport)
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

## 113. Bidirectional ABM-L

**Status:** Not started
**Priority:** Low
**Source:** ABM Simplification #2 nice-to-have

Agent writes memories directly in ABM-L format (`--abml "[D|coding|convict|5] @clerk >over @auth0 (pricing+DX)"`). No compression step — agent thinks in memory language. Needs format validation + English fallback if malformed. Low priority — needs more thought on validation strategy.

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
**Status:** Not started

**Problem:** If a subagent model (sleep, browse, coding) is misconfigured or unavailable (404, 429), the subagent burns through all retries and fails completely. We hit this with `nemotron-3:cloud` (wrong name → 404 × 18 attempts) and `qwen3-coder-next` (not available → "all models exhausted").

**Solution:**
1. Startup health check: verify all configured models respond (lightweight ping, not full prompt)
2. Runtime fallback: if a subagent model returns 404/429, fall back to the main agent model
3. Log clearly which model was unavailable and what it fell back to

**Affected models:** `AGENT_SLEEP_MODEL`, `AGENT_BROWSE_MODEL`, `AGENT_CODING_MODEL`

## 119. Transport Profiles → transport.json

**Status:** Not started
**Priority:** Medium

Replace the 4 flat `.env` transport profiles with a single `transport.json` per deployment. Structured, per-agent config, no more inconsistent key names.

```json5
// ~/.agentbridge/transport.json
{
  "active": "kiro",
  "profiles": {
    "kiro": {
      "transport": "acp",
      "cli": "kiro-cli",
      "agents": {
        "professor": { "model": "minimax-m2.5", "contextWindow": 1000000 },
        "dreamy":    { "model": "minimax-m2.5", "contextWindow": 128000 },
        "browsie":   { "model": "minimax-m2.5", "contextWindow": 128000 },
        "coding":    { "model": "qwen3-coder-next", "contextWindow": 128000 }
      }
    },
    "gemini": {
      "transport": "acp",
      "cli": "gemini",
      "agents": {
        "professor": { "model": "gemini-2.5-flash", "contextWindow": 1000000 },
        "dreamy":    { "model": "gemini-2.5-flash", "contextWindow": 1000000 },
        "browsie":   { "model": "gemini-2.5-flash", "contextWindow": 1000000 },
        "coding":    { "model": "gemini-2.5-flash", "contextWindow": 1000000 }
      }
    },
    "openrouter": {
      "transport": "api",
      "endpoint": "https://openrouter.ai/api/v1",
      "agents": {
        "professor": { "model": "qwen/qwen3.6-plus:free", "contextWindow": 1000000 },
        "dreamy":    { "model": "minimax/minimax-m2.5:free", "contextWindow": 196608 },
        "browsie":   { "model": "minimax/minimax-m2.5:free", "contextWindow": 196608 },
        "coding":    { "model": "qwen/qwen3-coder:free", "contextWindow": 131072 }
      }
    },
    "ollama": {
      "transport": "api",
      "endpoint": "http://localhost:11434/v1",
      "agents": {
        "professor": { "model": "kimi-k2.5:cloud", "contextWindow": 262144 },
        "dreamy":    { "model": "minimax-m2.5:cloud", "contextWindow": 128000 },
        "browsie":   { "model": "minimax-m2.5:cloud", "contextWindow": 131072 },
        "coding":    { "model": "qwen3.5:cloud", "contextWindow": 131072 }
      }
    }
  }
}
```

**Benefits:**
- One file, all profiles, structured
- Per-agent model + context window in one place
- No more `AGENT_MODEL` vs `AGENT_MAIN_MODEL` vs `API_MODEL` inconsistency
- Switch profile: change `"active"` field or `AGENT_TRANSPORT_PROFILE` env
- API keys stay in `.env` / `.env.skills` (secrets not in JSON)

**Risks:**
- JSON syntax error = bridge won't start. Mitigation: validate on load, fall back to last known good, `JSON.parse` with try/catch + clear error message.

**Implementation:**
- New `loadTransportConfig()` reads `transport.json`, falls back to env vars if file missing
- Agent registry reads from transport config instead of env vars
- Deploy copies `transport.json` from repo (merge-based like `.env`)
- Old `.env` transport profiles kept as fallback during migration

**Effort:** ~3hr

## 120. Replace .processed.json with file rename in retro-extract

**Priority:** MEDIUM
**Status:** Not started

**Problem:** `retro-extract` tracks processed retrospective files via a separate `.processed.json` in the retro directory. This is an extra state file to manage.

**Solution:** Rename processed retro files to `<name>.done` (or `.old`) after extraction. The extract step globs for `retro_*.md` — renamed files won't match. No JSON tracking needed, filesystem is the state.

**Files:** `src/cli/agentbridge-retro-extract.ts`

## 121. Request Collision — Idle Gate for Smart Crons + Ollama Parallel

**Priority:** HIGH
**Status:** Not started

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
**Status:** Not started

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
**Status:** Not started
**Spec:** [memory-decoupling.plan.md](../specs/memory-decoupling.plan.md)
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

## 124. Universal Memory CLI

**Priority:** MEDIUM
**Status:** Not started
**Depends on:** #123

Unified `agentbridge-memory` CLI with subcommands: `store`, `recall`, `edit`, `search`, `status`, `embed`, `wake-up`. Works standalone without the bridge running. Replaces individual CLIs (`agentbridge-recall`, `agentbridge-store`, `agentbridge-edit`, `agentbridge-expand`, `agentbridge-embed`).

## 125. Memory MCP Server

**Priority:** MEDIUM
**Status:** Not started
**Depends on:** #123

Expose memory operations as MCP tools for any MCP-compatible AI tool (Claude Code, Cursor, Kiro CLI, OpenClaw). Tools: `memory_recall`, `memory_store`, `memory_edit`, `memory_status`, `memory_wake_up`. Modeled on MemPalace's 19-tool MCP server, adapted to our architecture.

**Architecture:** MCP server wraps `IMemorySystem` from `@agentbridge/memory`. Two modes:
- **Standalone:** `npx @agentbridge/memory mcp` — spawns its own MemoryManager, opens SQLite directly
- **Bridge-attached:** connects to running bridge via IPC (existing backend factory) — shares the live DB

This means external tools (Claude Code, Cursor) get memory access without the bridge running, while the bridge's own agents can also use MCP if preferred over direct import.

## 126. OpenClaw Memory Plugin

**Priority:** LOW
**Status:** Not started
**Depends on:** #123, #125

Implement `@openclaw/memory-host-sdk` contract. Any OpenClaw agent gets persistent memory by adding the plugin. Bridge not required.
