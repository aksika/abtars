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
**Status:** Not started
**Roadmap:** [abm-roadmap.md](../specs/abm-roadmap.md)
**Specs:** [memory-v2-tiered.plan.md](../specs/memory-v2-tiered.plan.md), [memory-decoupling.plan.md](../specs/memory-decoupling.plan.md), [mempalace-study.md](../specs/mempalace-study.md)

### Phase 0: Decouple (refactor)
- Extract `@agentbridge/memory` standalone package from bridge
- IMemorySystem interface, eliminate DB leaks, directory reorg

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

### Phase 3: Universal Access
- Unified `agentbridge-memory` CLI (standalone, no bridge needed)
- MCP server — expose memory as MCP tools for any AI tool
- OpenClaw plugin via `@openclaw/memory-host-sdk`

## 92. Review Dead Code — migration versions in memory-db.ts

**Priority:** LOW

Review whether old migration versions in `memory-db.ts` still need to be kept. Clean up any dead migration code that's no longer needed.

## 93. Semantic Recall Cache

**Priority:** LOW
**Status:** Not started

In-memory cache for recall results within a session. If the agent queries the same (or semantically similar) keywords twice, return cached results instead of hitting SQLite + embeddings again. Simple `Map<string, SearchResult[]>` cleared on session reset. ~10 lines. No external dependency.

Inspired by Redis LangCache concept (O'Reilly "Managing Memory for AI Agents") but implemented as a trivial in-process cache.

## 96. ABM-L compressor quality fixes

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

**Priority:** HIGH
**Status:** Not started

Entity header + topic grouping + elide defaults in wake-up rendering. Daily summary compression to ABM-L. Compressed SOUL for <32K models. Adaptive full/compact/ultra based on context budget.

## 104. ABM-L storage optimization

**Priority:** MEDIUM
**Status:** Not started

D2: Strip prefix from stored ABM-L, reconstruct from columns at render time. D3: ABM-L aware merge (duplicate detection on compressed content). FTS5 on content_compressed only (replace English FTS5).

## 105. Embedding tiering — separate table + int8 quantization

**Priority:** MEDIUM
**Status:** Not started

Move embeddings to memory_embeddings table. Quantize float32→int8 after 14 days (384 bytes vs 1536). int8 kept forever. Main table stays lean.

## 106. ABM v2 wiring — connect planned features

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
