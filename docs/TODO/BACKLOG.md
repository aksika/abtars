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

## 49. Cohere STT/TTS Integration

**Status:** ⏸ Postponed — no Hungarian support
**Priority:** Medium

Cohere Transcribe supports 14 languages (EN, DE, FR, IT, ES, PT, EL, NL, PL, VI, ZH, AR, JA, KO). No Hungarian — unusable for Molty's Hunglish conversations. Revisit if they add Hungarian. No TTS offering either — Edge TTS stays.

## 64. STT gibberish detection + safe languages

**Status:** Not started
**Priority:** low
**Effort:** small

Whisper sometimes transcribes Hungarian voice notes as other languages (e.g. "ügyes vagy" → "видясь влаге" in Russian). Add `STT_SAFE_LANGUAGES` env var (default: `hu,en`). If transcription contains non-Latin/non-Hungarian script, flag as potential STT failure. SOUL adjustment: Molty should creatively recognize gibberish and ask user to repeat ("Nem értettem a hangüzenetet, megismétled?" instead of generic "Mi van?").

## 66. In-process memory CLI interception

**Status:** ✅ Done (superseded by refactor #4 — CLI IPC)
**Priority:** high

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

### Research findings (2026-04-02)

**Measured overhead:** ~176ms per CLI call on Mac Mini (node spawn + DB init + embedding check + store + close). Not as slow as expected.

**Permission handler limitation:** ACP `RequestPermissionRequest` only allows approve/cancel — cannot replace tool output. The bridge cannot intercept and return results at the permission level.

**Viable approaches:**
1. **Local HTTP API** — bridge exposes `/memory/store` etc. CLI tools check if bridge is running, call API instead of opening DB. Simple but adds HTTP overhead.
2. **Unix socket IPC** — bridge listens on socket, CLI tools connect. Faster than HTTP, more code.
3. **No-init mode** — CLI tools skip embedding init with `--fast` flag. Bridge handles embedding async. Quickest win but partial.
4. **Environment variable routing** — CLI tools check `AGENTBRIDGE_MEMORY_PORT`, if set, use HTTP to bridge instead of direct DB.

**Decision:** Deferred. 176ms per call is acceptable for conversation (LLM turns take seconds). For sleep with 10 stores = 1.7s total overhead — not critical. Revisit when store frequency increases significantly or when sleep extraction moves fully in-process (step 04b already code-driven).

**When to implement:** If Molty starts storing 20+ memories per conversation (proactive SOUL), the cumulative overhead becomes noticeable. Or if sleep extraction needs 50+ stores per cycle.

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

## 69. OpenRouter / 9Router integration

**Priority:** medium
**Status:** Not started (9Router security audit done: `docs/9ROUTER-SECURITY-AUDIT.md`)
**Effort:** medium

Add OpenRouter as a transport provider alongside kiro-cli. Enables model diversity (Claude, GPT, Gemini, open-source) without separate CLI tools. 9Router is the self-hosted variant — security audit completed, deployment plan needed.

## 74. Model switching via /model command

**Priority:** medium
**Status:** Not started
**Effort:** medium

`/model` currently passes through to CLI (shows current model only, no switching via ACP).

### Design
- `/model` — show current model name
- `/model list` — list available models (from transport profile or provider API)
- `/model <name>` — switch: destroy transport → reinit with `--model <name>`

Model list source depends on transport:
- kiro-cli: hardcoded list in transport profile (`AGENT_AVAILABLE_MODELS=model1,model2,...`)
- Raw model (future): query provider API (`/models` endpoint)

Switching requires transport restart (new `--model` flag). Session resets — use `pendingSessionStart` for SOUL re-injection.

## 77. Agent Sandbox — Restrict File/Command Access

**Priority:** HIGH
**Status:** Not started

### Problem
Agent modified source code in `~/agentbridge/` (developer repo) without permission. Agent notes say "don't modify code" but the agent ignored it. Notes are advisory — the agent can bypass them. Need enforcement, not guidance.

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

## 78. Enhanced Testing Strategy

**Priority:** HIGH
**Status:** Partial — smoke + e2e tests exist, unit coverage strong (764 tests)

### Current State
- 731 unit tests + property-based tests (fast-check)
- 1 e2e test (memory subsystem)
- No integration, smoke, or contract tests

### Phase 1: Smoke Test
Single test that verifies the bridge lifecycle:
1. Start bridge with mock transport
2. Send one message through pipeline
3. Verify response delivered
4. Shut down cleanly, no orphaned processes

Run after every deploy. Would have caught: `setBrowserManager` crash, SOUL truncation, sleep queue blocking.

### Phase 2: Integration Tests
Test real component combinations without full bridge:
- **Pipeline + Transport**: real message-pipeline + real AcpTransport (mocked CLI process). Verify SOUL injection reaches transport, interceptor doesn't truncate session-start, resetAndPrepare triggers re-injection.
- **Heartbeat + Tasks**: real HeartbeatSystem + real task callbacks. Verify clock-sync, standby detection, age-check fires at SLEEP_TIME.
- **Sleep + Memory**: real sleep spawn + real DB. Verify audit file created, watermark advanced, daily summary written.

### Phase 3: Contract Tests
Verify ACP protocol compatibility between our transport and CLI providers:
- **Kiro contract**: initialize → newSession → prompt → response with chunks → permission request → tool calls → resetSession. Verify all message types handled.
- **Gemini contract**: same flow but with Gemini-specific behaviors — `cancelled` stopReason on concurrent prompts, no `contextUsagePercentage` metadata, `--acp -y` flags.
- Run against recorded fixtures (not live CLIs) for speed and determinism.
- Update fixtures when CLI versions change.

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
## 88. Browser Container Auto-Stop

**Priority:** MEDIUM
**Status:** Not started

### Problem
Browser Docker containers (Lightpanda, Patchright) keep running after browse tasks complete. Wastes RAM (~500MB each) on the Mac Mini when not in use.

### Solution
Detect when no browse tasks have run for N minutes, then stop idle containers. Options:
- Heartbeat task that checks last browse timestamp and stops containers if idle
- `BrowserManager.shutdown()` called after task completion with a grace period
- Docker `--rm` flag for one-shot containers (Lightpanda already does this?)

Should handle both engines independently — Lightpanda may be idle while Patchright is active.

**Status:** ✅ Done
**Source:** `docs/asbuilts/pain-points.md` PP#5

Session-start prompts bypass the MessageInterceptor entirely. SOUL + context injection is expected to be large.

