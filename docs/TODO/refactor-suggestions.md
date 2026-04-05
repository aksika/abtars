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

## Priority Order

If tackling these incrementally:

1. **#6 Schema versioning** — lowest effort, prevents future migration bugs
2. **#7 Injectable paths** — mechanical, improves testability
3. **#3 Eliminate getDb()** — additive (add methods first, remove escape hatch after)
4. **#5 Typed config groups** — compiler-assisted, no runtime risk
5. **#1b Bridge class** — medium effort, prerequisite for plugin system
6. **#1 Capability plugin system** — the big payoff: plug-and-play subsystems
7. **#4 CLI IPC** — high effort but biggest performance win for sleep cycle
8. **#2 Event pipeline** — highest effort, only worth it if pipeline changes frequently
