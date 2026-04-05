# Refactor Suggestions — Future Architecture Improvements

> Generated: 2026-04-04 after full codebase review and cleanup pass.
> These are structural changes that would require significant effort but improve long-term maintainability.
> Not bugs — the system works correctly as-is.

---

## 1. Capability plugin system (replace hardwired subsystems)

**Problem:** Every capability (browser, cron, coding mode, sleep, A2A) is hardwired in `bridge-app.ts`. Adding a new capability (Slack adapter, different browser engine, new tool) requires editing the god function. There's no way to attach or detach capabilities without code changes.

The `ServiceRegistry` already solves this for platforms (Telegram, Discord) — they register with a factory and can be started/stopped dynamically. But browser, cron, coding mode, and sleep don't use this pattern.

**Reference:** OpenClaw's plugin architecture (`src/plugins/registry.ts`, `extensions/*/index.ts`). Key patterns:
- `PluginRegistry` with typed slots: tools, commands, services, channels, hooks, httpRoutes
- Each plugin gets a constrained `OpenClawPluginApi` with `registerTool()`, `registerCommand()`, `registerService()`, `registerChannel()`, `on()` (typed hooks)
- Plugins live in self-contained directories (`extensions/<name>/index.ts`) exporting `register(api)`
- Channels (Telegram, Discord, Matrix, MSTeams, etc.) are all plugins implementing `ChannelPlugin`

**Suggestion:** A `CapabilityRegistry` with typed slots, adapted from OpenClaw's pattern:

```typescript
// Registry with typed slots (inspired by OpenClaw's PluginRegistry)
interface CapabilityRegistry {
  commands: Map<string, CommandHandler>;
  heartbeatTasks: HeartbeatTask[];
  services: Map<string, ServiceFactory>;
  platforms: Map<string, PlatformFactory>;
}

// Constrained API given to each capability (inspired by OpenClawPluginApi)
interface CapabilityApi {
  registerCommand(name: string, handler: CommandHandler): void;
  registerHeartbeatTask(task: HeartbeatTask): void;
  registerService(name: string, factory: ServiceFactory): void;
  registerPlatform(name: string, factory: PlatformFactory): void;
  config: BridgeConfig;
  memory: MemoryManager;
  transport: IKiroTransport;
}

// Each capability is a self-contained module (inspired by extensions/*/index.ts)
// src/capabilities/browser/index.ts
export function register(api: CapabilityApi): void {
  const manager = new BrowserManager();
  const tool = new BrowserTool(manager, DomainAllowlist.fromEnv());
  api.registerHeartbeatTask(browseCheckerTask);
  api.registerService("browser-ipc", { ... });
}

// bridge-app.ts becomes:
const bridge = new Bridge(config);
const api = bridge.createCapabilityApi();
registerBrowser(api);       // src/capabilities/browser/
registerCron(api);          // src/capabilities/cron/
registerCodingMode(api);    // src/capabilities/coding/
await bridge.start();
```

**What this enables:**
- Add a new capability by writing one directory and one `register()` call
- Disable capabilities via config (`CAPABILITIES=telegram,memory,cron`)
- Self-contained modules: `src/capabilities/browser/`, `src/capabilities/cron/`
- Test capabilities in isolation (mock the CapabilityApi)
- Bridge core becomes ~200 lines: config → transport → registry → start

**Key difference from OpenClaw:** We don't need third-party plugin loading, dynamic discovery, or plugin-SDK re-exports. First-party capabilities with static imports are sufficient.

**Depends on:** #1b (Bridge as a class) — capabilities need a Bridge instance to wire into.

**Effort:** High. **Risk:** Medium (incremental — migrate one capability at a time).

---

## 1b. Bridge as a class (replace startBridge god function)

**Problem:** `startBridge()` is a ~677-line closure with 20+ mutable variables. Every new feature adds more lines to the same function.

**Suggestion:** Create a `Bridge` class with phased initialization:
```
class Bridge {
  private transport, platforms, heartbeat, memory, ...
  async start() { initTransport → initPlatforms → initHeartbeat → initDashboard }
  async shutdown() { single exit path }
}
```
The Bridge class is the foundation that capabilities register into. Without it, the capability registry has nothing to attach to.

**Effort:** Medium. **Risk:** Medium (touches all wiring).

---

## 2. Event-driven message pipeline (replace 300-line handleInboundMessage)

**Problem:** `handleInboundMessage()` is one giant function handling: voice transcription, command dispatch, prompt building, streaming setup, response delivery, memory recording, TTS, reactions, and compaction. Adding a new step means editing the monolith.

**Suggestion:** Middleware chain or event emitter:
```
message.received → transcribe → authorize → buildPrompt → send →
stream → deliver → recordMemory → checkCompaction
```
Each step is a small function. Streaming becomes transport-emitted `chunk` events instead of per-transport callback wiring.

**Effort:** High. **Risk:** High (core message flow).

---

## 3. Eliminate getDb() escape hatch

**Problem:** 5+ files reach through `memory.getDb()` to run raw SQL: session-context, idle-compact, age-check, dashboard, sleep. The DB schema is a public API surface.

**Suggestion:** Every query becomes a method on the appropriate sub-service (MessageStore, MaintenanceService, etc.). Remove `getDb()` and `getDatabase()`. If you need a new query, add a method.

**Files affected:** bridge-app.ts (idle-compact, age-check), session-context.ts, heartbeat-tasks.ts, dashboard-server.ts, compaction.ts, sleep CLIs.

**Effort:** Medium. **Risk:** Low (additive — add methods, then remove getDb).

---

## 4. CLI tools as IPC clients (not standalone MemoryManager instances)

**Problem:** Every CLI invocation (`agentbridge-store`, `agentbridge-edit`, `agentbridge-recall`) creates its own MemoryManager, opens the DB, runs migrations, does one operation, and exits. ~200ms+ startup per call. The sleep cycle calls these dozens of times.

**Suggestion:** Either:
- **Unix socket IPC:** Long-running memory service (like browser IPC already works). CLI tools send JSON commands over socket.
- **Single CLI with subcommands:** `agentbridge-memory store ...`, `agentbridge-memory edit ...` — one process, one DB connection, multiple operations.

**Effort:** High. **Risk:** Medium (changes CLI interface that agent prompts reference).

---

## 5. Typed config groups (replace flat 37-field Config)

**Problem:** `Config` has 37 fields in a flat structure. `PipelineDeps` carries 20+ fields because consumers need "some of config." No clear ownership.

**Suggestion:** Group by domain:
```typescript
type Config = {
  telegram: TelegramConfig;
  discord: DiscordConfig;
  transport: TransportConfig;
  voice: VoiceConfig;
  models: ModelConfig;
}
```
Each consumer takes only the group it needs.

**Effort:** Medium. **Risk:** Low (type-level change, compiler catches everything).

---

## 6. Schema migration versioning

**Problem:** Migrations are idempotent ALTER TABLE with empty catch blocks. Can't tell which ran, can't roll back. Currently all in memory-db.ts but historically were split across two files.

**Suggestion:** `schema_version` table + numbered migration functions:
```typescript
const migrations = [
  { version: 1, up: (db) => db.exec("CREATE TABLE ...") },
  { version: 2, up: (db) => db.exec("ALTER TABLE ...") },
];
```
Run only migrations above current version. Store version in DB.

**Effort:** Low. **Risk:** Low (additive — wrap existing DDL in version checks).

---

## 7. Injectable paths (replace hardcoded homedir)

**Problem:** `homedir() + ".agentbridge"` computed independently in 10+ files. `AGENT_BRIDGE_HOME` exists in config.ts but cron-db, sleep-trigger, heartbeat-system, and others compute their own paths.

**Suggestion:** All paths flow from config. No module-level `homedir()` calls. Pass paths through constructors or config objects.

**Effort:** Low. **Risk:** Low (mechanical find-and-replace).

---

## 8. Pluggable memory backends (formalize the CLI abstraction boundary)

**Problem:** The CLI tools (`agentbridge-store`, `agentbridge-recall`, `agentbridge-edit`) already decouple the agent from the storage layer — the agent calls CLI tools that return JSON, it doesn't know what's underneath. But internally, every CLI tool hardcodes `new MemoryManager()` → SQLite+FTS5. There's no way to swap the backend without rewriting the CLI tools.

**Current state (90% decoupled):**
```
Agent → execute_bash: agentbridge-store → MemoryManager → SQLite+FTS5
Agent → execute_bash: agentbridge-recall → MemoryManager → SQLite+FTS5
Agent → execute_bash: agentbridge-edit → MemoryManager → SQLite+FTS5
```

**Suggestion:** Extract a `MemoryBackend` interface. CLI tools instantiate the configured backend instead of hardcoding MemoryManager:

```typescript
interface MemoryBackend {
  initialize(): Promise<void>;
  store(params: InstantStoreParams): Promise<InstantStoreResult>;
  edit(params: EditMemoryParams): EditMemoryResult;
  recall(query: string, opts: RecallParams): Promise<RecallResult>;
  close(): Promise<void>;
}

// Current implementation becomes one backend:
class SqliteBackend implements MemoryBackend { ... }

// Future backends:
class HonchoBackend implements MemoryBackend { ... }
class Mem0Backend implements MemoryBackend { ... }
class RedisBackend implements MemoryBackend { ... }
```

Config selects the backend: `MEMORY_BACKEND=sqlite` (default) or `MEMORY_BACKEND=honcho`.
CLI tools stay identical — same flags, same JSON output. Agent behavior unchanged.

**New CLI: `agentbridge-massedit`**

Batch operations on memories using an ORM-style query builder (no raw SQL from agent input):

```bash
agentbridge-massedit \
  --where-keyword "preferences" \
  --where-type "fact" \
  --set-trust 3 \
  --set-classification 1 \
  --dry-run
```

Design constraints:
- **ORM-style query builder** — all filtering via typed parameters (`--where-keyword`, `--where-type`, `--where-created-after`, `--where-emotion-range`), never raw SQL. Prevents SQL injection from agent-generated input.
- **Dry-run by default** — shows what would change before committing. Agent must explicitly pass `--commit`.
- **Audit trail** — logs every batch edit with timestamp, caller, filter criteria, and count of affected rows.
- **Backend-agnostic** — uses the `MemoryBackend` interface, works with any backend.

**Reference:** Hermes Agent's `MemoryProvider` ABC (`agent/memory_provider.py`) — same concept of pluggable backends behind a stable interface. 7 providers ship as plugins.

**Depends on:** #3 (eliminate getDb) — callers must use the backend interface, not raw DB access.

**Effort:** Medium. **Risk:** Low (additive — new interface wraps existing code, CLI tools unchanged externally).

---

## 10. Async status checks (replace blocking execSync)

**Problem:** `buildStatusLines()` in `command-handlers.ts` calls `execSync` 3 times: `kiro-cli settings list` (3s timeout), `mcporter list` (15s timeout), `mcporter --version` (5s timeout). These block the event loop — a slow MCP server means `/status` freezes the entire bridge for up to 15 seconds.

**Suggestion:** Replace with `execFile` (async) or `spawn` with timeout. Return partial results if a check times out.

**Effort:** Low (~20 lines). **Risk:** None.

---

## ~~11. Shared CLI arg parsing~~ — DROPPED

Reviewed during implementation: actual duplication is ~6 lines of boilerplate per CLI (slice, help check, for-loop skeleton). Flag definitions and validation are unique to each CLI. A shared utility would be ~30 lines itself — net savings near zero. Not worth a module.

---

## 12. Command dispatch table (replace handleCommand if/else chain)

**Problem:** `handleCommand()` in `command-handlers.ts` is a 250+ line if/else chain. Each command (`/new`, `/reset`, `/compact`, `/coding`, `/status`, etc.) is an inline block. Adding a new command means finding the right spot in the chain.

**Suggestion:** Dispatch table mapping command names to handler functions:

```typescript
const commands: Record<string, (ctx: CommandContext) => Promise<boolean>> = {
  "/new": handleNew,
  "/reset": handleReset,
  "/compact": handleCompact,
  "/status": handleStatus,
  // ...
};
```

Prefix-match commands (`/tasks trigger`, `/tasks log`, `/nlm`) use a separate prefix table.

**Effort:** Low (~30 min). **Risk:** None (mechanical extraction).

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

Each step makes the next one easier — the sequence builds toward sandboxing:

1. **#6 Schema versioning** — lowest effort, prevents future migration bugs
2. **#7 Injectable paths** — mechanical, improves testability
3. **#10 Async status checks** — 20 lines, stops /status from freezing the bridge
4. **#12 Command dispatch table** — mechanical extraction, cleaner command handling
5. **#3 Eliminate getDb()** — additive (add methods first, remove escape hatch after)
6. **#5 Typed config groups** — compiler-assisted, no runtime risk
7. **#1b Bridge class** — medium effort, prerequisite for plugin system
8. **#1 Capability plugin system** — the big payoff: plug-and-play subsystems
9. **#8 Pluggable memory backends** — swap memory backends without touching bridge code
10. **#4 CLI IPC** — high effort but biggest performance win for sleep cycle
11. **#2 Event pipeline** — highest effort, only worth it if pipeline changes frequently
12. **#9 Agent sandboxing** — the end goal: NemoClaw-style isolation for the agent layer
