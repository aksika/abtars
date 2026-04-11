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
**Status:** ✅ Done (2026-04-11)

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

## 93. Semantic Recall Cache

**Priority:** LOW
**Status:** Not started

In-memory cache for recall results within a session. If the agent queries the same (or semantically similar) keywords twice, return cached results instead of hitting SQLite + embeddings again. Simple `Map<string, SearchResult[]>` cleared on session reset. ~10 lines. No external dependency.

Inspired by Redis LangCache concept (O'Reilly "Managing Memory for AI Agents") but implemented as a trivial in-process cache.

## 96. ABM-L compressor quality fixes

**Status:** 🅿️ Parked (2026-04-11)
**Priority:** LOW
**Done:** Filler bug fixed (ABM Simplification #2). Remaining items (entity whitelist, negation preservation, pipe-separate, abbreviations) are nice-to-have — not blocking.

## 103. ABM-L Compression Level 2 — wake-up rendering

**Status:** 🅿️ Parked (2026-04-11)
**Priority:** LOW
**Done:** Multi-resolution rendering shipped (signal/ultra/compact/full). Remaining: entity header + topic grouping saves ~20% more tokens but we're at 2% context on 1M models. Only matters for tiny models.

## 104. ABM-L storage optimization

**Status:** Partially done / partially obsolete (2026-04-11)
**Done:** content_compressed column dropped, ABM-L rendered on read.
**Obsolete:** D3 ABM-L aware merge — signature-based merge candidates in `buildSleepCandidates()` already handle dedup detection.
**Remaining:** FTS5 on ABM-L only (replace English FTS5) — parked, current hybrid works.

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

## 113. Bidirectional ABM-L

**Status:** Not started
**Priority:** Low
**Source:** ABM Simplification #2 nice-to-have

Agent writes memories directly in ABM-L format (`--abml "[D|coding|convict|5] @clerk >over @auth0 (pricing+DX)"`). No compression step — agent thinks in memory language. Needs format validation + English fallback if malformed. Low priority — needs more thought on validation strategy.

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

## 125. Memory MCP Server

**Priority:** MEDIUM
**Status:** Not started
**Depends on:** #123

Expose memory operations as MCP tools for any MCP-compatible AI tool (Claude Code, Cursor, Kiro CLI, OpenClaw). Tools: `memory_recall`, `memory_store`, `memory_edit`, `memory_status`, `memory_wake_up`. Modeled on MemPalace's 19-tool MCP server, adapted to our architecture.

**Architecture:** MCP server wraps `IMemorySystem` from `abmind`. Two modes:
- **Standalone:** `npx abmind mcp` — spawns its own MemoryManager, opens SQLite directly
- **Bridge-attached:** connects to running bridge via IPC (existing backend factory) — shares the live DB

**Security:** All MCP tool handlers must call `scanForInjection()` before writing (store/edit). The CLI already does this — MCP must match. See #127.

## 126. OpenClaw Memory Plugin

**Priority:** LOW
**Status:** Not started
**Depends on:** #123, #125

Implement `@openclaw/memory-host-sdk` contract. Any OpenClaw agent gets persistent memory by adding the plugin. Bridge not required.

## 127. Prompt Injection Scanner

**Priority:** MEDIUM
**Status:** Not started

Scan incoming content (skills, user messages, tool outputs) for prompt injection attempts before they reach the agent's context window.

**Surfaces to scan:**
- ClawHub community skills on install/update (#79)
- User messages (defense-in-depth — agent already has SOUL.md rules)
- Tool outputs (browse results, file content)
- Memory store content (#9 covers this specifically)

**Tools to evaluate:**

| Tool | Language | Approach | Notes |
|---|---|---|---|
| [Prompt-Shield](https://github.com/prompt-shield) | Python | 22 concurrent detectors, DeBERTa ML classifier, self-learning vector vault, ensemble scoring | Local-only, no cloud API. Catches paraphrased attacks + obfuscated jailbreaks |
| [Vigil (vigil-llm)](https://github.com/deadbits/vigil-llm) | Python | Pre-LLM prompt evaluation, monitors for injections + jailbreaks | Open source, lightweight |
| [LLM Guard](https://github.com/protectai/llm-guard) | Python | Full firewall — PromptInjection scanner, risk scores, sanitization | By Protect AI, comprehensive but heavier |

**Integration options:**
1. **Python sidecar** — spawn scanner as subprocess, pipe content, get risk score. Similar to ollama embed pattern.
2. **Node.js port** — port detection patterns to TypeScript. More work but no Python dependency.
3. **MCP tool** — scanner as MCP server, agent can self-check. Requires MCP infra.

**Decision needed:** Which tool, which integration pattern. Evaluate on: accuracy, speed, resource usage, Python dependency acceptable?

**Effort:** ~4-8hr depending on approach
