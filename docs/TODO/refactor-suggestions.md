# Refactor Suggestions — Future Architecture Improvements

> Generated: 2026-04-04 after full codebase review and cleanup pass.
> These are structural changes that would require significant effort but improve long-term maintainability.
> Not bugs — the system works correctly as-is.

---

## 1. Capability plugin system (replace hardwired subsystems)

**Status:** ✅ Done (2026-04-05, `refactor/architecture-v2` branch)

`CapabilityApi` + `CapabilityRegistry` + auto-discovery via `capability.json` manifests. Three capabilities: browser (auto-discovered), hotskills (auto-discovered), sleep (core, always loaded). `DISABLED_CAPABILITIES` env var. `registerCommand()` for capability-added commands.

---

## 1b. Bridge as a class (replace startBridge god function)

**Status:** ✅ Done (2026-04-05, `refactor/architecture-v2` branch)

`Bridge` class in `bridge-app.ts` owns lifecycle (config, transport, memory, heartbeat, registry, shutdown). `startBridge()` creates instance and populates fields.

---

## 2. Event-driven message pipeline (replace 300-line handleInboundMessage)

**Status:** ✅ Done (2026-04-05, `refactor/architecture-v2` branch)

Middleware system: `MessageContext`, `Middleware` type, `runPipeline()`. Three middleware extracted: `voiceMiddleware`, `commandMiddleware`, `busyGuardMiddleware` in `src/components/pipeline/`.

---

## 3. Eliminate getDb() escape hatch

**Status:** ✅ Done (2026-04-05, `refactor/architecture-v2` branch)

Added methods to MessageStore and MaintenanceService. 8→4 callers remaining (all justified internal uses). `getDatabase()`/`getDb()` marked `@deprecated`.

---

## 4. CLI tools as IPC clients (not standalone MemoryManager instances)

**Status:** ✅ Done (2026-04-05, `refactor/architecture-v2` branch)

`MemoryIpcServer` (Unix socket `~/.agentbridge/memory.sock`), `IpcBackend` client. Factory tries IPC first, falls back to SQLite. `MEMORY_IPC=0` to disable.

---

## 5. Typed config groups (replace flat 37-field Config)

**Status:** ✅ Done (2026-04-05, `refactor/architecture-v2` branch)

Config split into `TelegramConfig`, `DiscordConfig`, `TransportConfig`, `VoiceConfig`, `ModelConfig`. Access: `config.telegram.botToken`, `config.transport.workingDir`, etc.

---

## 6. Schema migration versioning

**Status:** ✅ Done (2026-04-05, `refactor/architecture-v2` branch)

`schema_version` table, 6 numbered migrations, pre-versioning DB detection.

---

## 7. Injectable paths (replace hardcoded homedir)

**Status:** ✅ Done (2026-04-05, `refactor/architecture-v2` branch)

`agentBridgeHome()` in `src/paths.ts`, `AGENT_BRIDGE_HOME` env override, 29 files updated.

---

## 8. Pluggable memory backends (formalize the CLI abstraction boundary)

**Status:** ✅ Done (2026-04-05, `refactor/architecture-v2` branch)

`MemoryBackend` interface (fully async), `SqliteBackend`, `createMemoryBackend()` factory. CLI tools migrated to use factory (IPC first, SQLite fallback).

---

## 10. Async status checks (replace blocking execSync)

**Status:** ✅ Done (2026-04-05, `refactor/architecture-v2` branch)

`execSync` → `execFile` in `/status`, parallel kiro-cli + mcporter checks.

---

## ~~11. Shared CLI arg parsing~~ — DROPPED

Reviewed during implementation: actual duplication is ~6 lines of boilerplate per CLI (slice, help check, for-loop skeleton). Flag definitions and validation are unique to each CLI. A shared utility would be ~30 lines itself — net savings near zero. Not worth a module.

---

## 12. Command dispatch table (replace handleCommand if/else chain)

**Status:** ✅ Done (2026-04-05, `refactor/architecture-v2` branch)

250-line if/else → `exactCommands` Record + `prefixCommands` array + `KNOWN_COMMANDS` Set. `registerCommand()` for capability-added commands.

---

## 9. Agent sandboxing (NemoClaw-style isolation)

**Problem:** The bridge and the agent run in the same process/host. The agent (LLM-generated code via execute_bash) has full access to `~/.agentbridge/.env` (secrets), the network (curl anywhere), and the filesystem. A prompt injection or rogue tool call can exfiltrate secrets or modify bridge code.

**Prerequisite:** The capability plugin system (#1) creates the architectural seam between "trusted bridge" (host) and "untrusted agent" (sandboxable). Without it, everything is one monolith — nothing to sandbox.

**Suggestion:** Split into two layers after the plugin refactor:

```
┌─────────────────────────────────────────┐
│  Host (unsandboxed)                     │
│  - Bridge core (transport, heartbeat)   │
│  - Memory backend (SQLite)              │
│  - Platform adapters (Telegram/Discord) │
│  - Dashboard                            │
└──────────────┬──────────────────────────┘
               │ ACP over stdio (already exists)
┌──────────────▼──────────────────────────┐
│  Sandbox (Docker container)             │
│  - kiro-cli / agent process             │
│  - Browser (already Dockerized)         │
│  - Agent tools (execute_bash, etc.)     │
│  - Network: deny-by-default egress      │
│  - Filesystem: read-only except /sandbox│
│  - No access to .env, memory.db, bridge │
└─────────────────────────────────────────┘
```

**What the refactor enables:**
- Plugin system separates agent-facing capabilities from bridge internals
- ACP transport already provides the IPC boundary (stdio)
- Memory CLI tools already decouple agent from storage (#8)
- Browser is already in Docker — just needs network policy

**What's still needed (post-refactor):**
- Dockerfile for agent sandbox (NemoClaw's as reference)
- Network policy (allow kiro API endpoint, block internal network)
- Credential isolation (secrets stay on host, agent gets tokens via ACP)
- Filesystem policy (read-only system, writable /sandbox only)

**Reference:** NemoClaw's 4-layer defense: network (deny-by-default egress, binary-scoped rules), filesystem (Landlock LSM, read-only mounts), process (capability drops, non-root, no-new-privileges), inference (routed through gateway, agent never sees API keys).

**Effort:** High. **Risk:** Medium. **This is the end goal — every prior refactor step makes this possible without a rewrite.**

---

## Priority Order

All items complete except #9 (agent sandboxing). See BACKLOG.md #77 for Phase 1 (permission handler) and Phase 2 (Docker isolation).

| # | Item | Status |
|---|------|--------|
| 6 | Schema versioning | ✅ Done |
| 7 | Injectable paths | ✅ Done |
| 10 | Async status checks | ✅ Done |
| 12 | Command dispatch table | ✅ Done |
| 3 | Eliminate getDb() | ✅ Done |
| 5 | Typed config groups | ✅ Done |
| 1b | Bridge class | ✅ Done |
| 1 | Capability plugin system | ✅ Done |
| 8 | Pluggable memory backends | ✅ Done |
| 4 | CLI IPC | ✅ Done |
| 2 | Event pipeline | ✅ Done |
| 11 | Shared CLI parsing | ~~Dropped~~ |
| 9 | Agent sandboxing | Remaining (BACKLOG #77) |
