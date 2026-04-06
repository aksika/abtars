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

## 88. Auto-Skill Creation (Hermes-inspired)

**Priority:** HIGH
**Status:** Not started
**Reference:** Hermes Agent `tools/skill_manager_tool.py`, `run_agent.py` `_spawn_background_review()`

### Concept

Agent automatically creates and updates skills based on conversation experience. When a non-trivial approach succeeds (trial and error, user corrections, multi-step workflows), the system captures it as a reusable skill file.

### Hermes Architecture (studied)

1. **Background review trigger** — after every N turns (default 10), spawns a forked agent in a background thread with full conversation history. Sends a review prompt: "Was a non-trivial approach used? If a skill exists, update it. Otherwise create a new one if reusable."
2. **skill_manage tool** — 6 actions: create, edit, patch, delete, write_file, remove_file. Skills are SKILL.md with YAML frontmatter + markdown body. Stored in `~/.hermes/skills/` with category subdirs. Security scan on every write (rollback on block). Atomic writes. Cache invalidation after changes.
3. **Review prompt** — focuses on: trial-and-error approaches, user corrections, experiential findings, reusable workflows.

### AgentBridge Design

| Hermes | AgentBridge |
|---|---|
| `~/.hermes/skills/SKILL.md` | `~/.agentbridge/skills/*.md` (exists) |
| `skill_manage` tool | `agentbridge-skill` CLI (create/edit/patch/delete) |
| Background review thread | Sleep cycle step (Dreamy reviews day's conversations) |
| `_SKILL_REVIEW_PROMPT` | Same prompt, sent to Dreamy during sleep |
| Security scan | `prompt-scanner.ts` (exists) |
| Hot-reload after create | `SkillWatcher` hotskills capability (exists) |

### Implementation approach — sleep-based (not real-time)

Dreamy already reviews conversations for memory extraction. Add a new sleep step:

1. **New step: `skill-review`** — after daily summary + extraction, Dreamy reviews the day's conversations for skill-worthy patterns
2. **Prompt**: "Review today's conversations. Were there non-trivial approaches, trial-and-error, user corrections, or reusable workflows? Create or update skills as needed."
3. **`agentbridge-skill` CLI** — create/edit/patch/delete actions, YAML frontmatter validation, prompt-scanner security check, atomic writes
4. **SkillWatcher** picks up new/changed files on next heartbeat tick — agent sees them immediately

### Why sleep-based over real-time

- Cheaper — one review per day vs every 10 turns
- Dreamy has full day context — can spot patterns across conversations
- No background subagent competing for model attention during conversation
- Fits existing architecture — just another sleep step

### Future: real-time option

If needed later, add a heartbeat task that reviews the last N messages and spawns a review subagent (same pattern as Hermes). The `agentbridge-skill` CLI works for both approaches.

### Action items

- [ ] Create `src/cli/agentbridge-skill.ts` — create/edit/patch/delete with frontmatter validation + security scan
- [ ] Add sleep step `skill-review` after extraction steps
- [ ] Write skill review prompt (adapt from Hermes `_SKILL_REVIEW_PROMPT`)
- [ ] Test: verify SkillWatcher picks up agent-created skills
- [ ] Update TOOLS.md with `agentbridge-skill` syntax

**Effort:** Medium. **Risk:** Low (additive — new CLI + new sleep step, nothing changes).

## 89. Refactor 2b — startBridge() decomposition + PipelineDeps split

**Priority:** MEDIUM
**Status:** Not started
**Plan:** `docs/TODO/refactor-2b-plan.md` (#4, #5)
**Depends on:** needed by #69 (direct API transport)

### What's done (refactor 2b, items #1-#3)
- ✅ cron-checker reverse dependency eliminated
- ✅ retro-extract migrated to backend factory
- ✅ components/ organized into subdirectories (cron/, dashboard/, transport/)
- ✅ platforms/ restructured (telegram/, discord/ self-contained)
- ✅ Flaky auto-compact tests fixed

### What's deferred

**#4 startBridge() decomposition** — 548-line wiring function. Clean seams (initMemory, initTransport, initDashboard) could be extracted as Bridge methods. Messy seams (heartbeat, pipelineDeps, platforms) are too coupled — forced extraction adds indirection without reducing complexity. Revisit if #50 (memory decoupling) or multi-CLI creates a real need.

**#5 PipelineDeps split** — 25-field grab bag interface. Natural groupings (TransportDeps, MemoryDeps, SessionState) only become clear after #4. Skip until then.

### When to revisit
- #50 (Decouple Memory) needs `initMemory()` as integration point
- Multi-CLI support needs `initTransport()` as swap point
- Neither is imminent — this is "next time you're in the area" work

**Effort:** Medium. **Risk:** Low (mechanical, compiler-guided).


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
