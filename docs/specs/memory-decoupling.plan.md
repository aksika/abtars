# Memory System Decoupling — Implementation Plan

**Created:** 2026-03-29
**Updated:** 2026-04-07
**Status:** Not started
**Backlog:** #91 (ABM Phase 0)
**Roadmap:** [abm-roadmap.md](abm-roadmap.md)

## Goal

Extract the memory system into a standalone `@agentbridge/memory` package. The bridge imports it as a dependency. OpenClaw, MCP clients, or any Node.js app can use it independently.

## Current state (2026-04-07)

### What's already done
- **Directory reorg complete** — all 20 memory files live in `src/memory/` (was `src/components/`)
- **IPC client/server** — CLIs communicate with running bridge via IPC, or fall back to direct SQLite
- **Backend abstraction** — `MemoryBackend` interface with `SqliteBackend` and `IpcBackend` implementations
- **Backend factory** — `createMemoryBackend()` auto-selects IPC or SQLite

### What's still coupled

**Memory → Bridge dependencies (must be severed):**

| Import | Files | What it needs |
|---|---|---|
| `logger.js` | 8 memory files | `logInfo`, `logWarn`, `logError` |
| `env-utils.js` | 3 memory files | `parseBoolEnv`, `parseNumberEnv`, `localDate` |
| `paths.js` | 2 memory files | `agentBridgeHome()` |
| `heartbeat-system.ts` | `memory-manager.ts` | `HeartbeatSystem` class |
| `types/index.ts` | 6 memory files | `InstantStoreParams`, `EditMemoryParams`, `SearchResult`, etc. |
| `types/memory.ts` | 2 memory files | `SearchResult`, `MemorySearchResult`, `HeartbeatTask` |

**Bridge → Memory DB leaks (must be eliminated):**

| Caller | What it does | Replacement |
|---|---|---|
| `sleep-state-gatherer.ts` | `memory.getDatabase()` — raw SQL queries for stats | Add `gatherSleepState()` to interface |
| `agentbridge-sleep.ts` | `memory.getDatabase()` — raw SQL for watermarks | Add `getExtractionWatermark()` / `setExtractionWatermark()` |
| `memory-search-controller.ts` | `memory.getDatabase()` + `memory.getMemoryIndex()` | Add `searchMemories()` / `getEntities()` to interface |
| `heartbeat-tasks.ts` | `memory.store.getLastMessageTimestamp()` | Add `getLastMessageTimestamp()` to interface |

### Consumer dependency map (updated)

| Bridge file | Memory methods used | Coupling level |
|---|---|---|
| `bridge-app.ts` | initialize, close, getDatabase, getMemoryIndex, getStats, setHeartbeat | Heavy — DB leaks |
| `message-pipeline.ts` | recordMessage, buildSessionStartContext, getConfig | Medium — session-context is in memory/ |
| `compaction.ts` | buildMemoryContext | Light |
| `command-handlers.ts` | getStats, readCoreKnowledge, getCronInfo | Clean |
| `telegram-adapter.ts` | updateEmotionByPlatformId, emojiToScore | Clean |
| `discord-adapter.ts` | updateEmotionByPlatformId, emojiToScore | Clean |
| `agent-api-server.ts` | recordMessage | Clean |
| `heartbeat-tasks.ts` | store.getLastMessageTimestamp | DB leak |
| `memory-search-controller.ts` | getDatabase, getMemoryIndex, store.* | Heavy — DB leaks |
| `sleep-state-gatherer.ts` | getDatabase — raw SQL | Heavy — DB leak |
| `agentbridge-sleep.ts` | getDatabase — raw SQL | Heavy — DB leak |
| `daily-cycle.ts` | type import only | Clean |

### CLIs that move with the package

| CLI | What it does |
|---|---|
| `agentbridge-recall` | Search memories (uses backend factory) |
| `agentbridge-store` | Instant store (uses backend factory) |
| `agentbridge-edit` | Edit memories (uses backend factory) |
| `agentbridge-expand` | Expand source message IDs |
| `agentbridge-embed` | Batch embed via ollama |
| `agentbridge-retro-extract` | Retro-extract from messages |

---

## Phase 0.1: Internalize bridge utilities

Copy the small utilities that memory needs into the memory package. Don't import from bridge.

**Logger:** Create `src/memory/logger.ts` — minimal logger (same interface, standalone). 3 functions: `logInfo`, `logWarn`, `logError`. ~15 lines.

**Env utils:** Create `src/memory/env-utils.ts` — copy `parseBoolEnv`, `parseNumberEnv`, `localDate`. ~20 lines.

**Paths:** Create `src/memory/paths.ts` — copy `agentBridgeHome()`. ~5 lines.

**Types:** Create `src/memory/types.ts` — move all memory-related types (`InstantStoreParams`, `EditMemoryParams`, `SearchResult`, `SearchOptions`, `ForgetResult`, `MessageRecord`, `HeartbeatTask`, etc.) into memory package. Bridge re-exports from memory.

**Effort:** ~1 hour. Mechanical.

## Phase 0.2: Eliminate DB leaks

Remove `getDatabase()` and `getMemoryIndex()` from `MemoryManager` public API.

**Add to MemoryManager:**
```typescript
gatherSleepState(): SleepStateSnapshot;           // replaces sleep-state-gatherer raw SQL
getExtractionWatermark(chatId: number): number;    // replaces agentbridge-sleep raw SQL
setExtractionWatermark(chatId: number, ts: number): void;
searchDashboard(query: string, opts: DashboardSearchOpts): DashboardSearchResult;  // replaces memory-search-controller raw SQL
getLastMessageTimestamp(allChats?: boolean): number;  // replaces heartbeat-tasks .store access
```

**Move `SleepStateGatherer` into `src/memory/`** — it's a memory concern, not a sleep concern.

**Update callers:**
- `sleep-state-gatherer.ts` → calls `memory.gatherSleepState()` instead of raw SQL
- `agentbridge-sleep.ts` → calls `memory.getExtractionWatermark()` / `setExtractionWatermark()`
- `memory-search-controller.ts` → calls `memory.searchDashboard()` instead of raw SQL
- `heartbeat-tasks.ts` → calls `memory.getLastMessageTimestamp()` instead of `.store.`

**Effort:** ~2-3 hours. Some SQL moves into MemoryManager methods.

## Phase 0.3: Define IMemorySystem interface

Extract the public API into an interface. MemoryManager implements it.

```typescript
export interface IMemorySystem {
  // Lifecycle
  initialize(): Promise<void>;
  close(): void;

  // Messages
  recordMessage(record: MessageRecord): void;
  loadRecentMessages(chatId: number, sessionId: string, count: number): MessageRecord[];
  getLastMessageTimestamp(allChats?: boolean): number;

  // Memories (CRUD)
  store(params: InstantStoreParams): Promise<InstantStoreResult>;
  edit(params: EditMemoryParams): EditMemoryResult;
  recall(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  merge(idA: number, idB: number): MergeResult;
  cascadeDelete(messageIds: number[], chatId: number): ForgetResult;

  // Emotion
  updateEmotionByPlatformId(chatId: number, platformMessageId: number, score: number): boolean;

  // Sessions
  persistSession(session: SessionState): void;
  restoreSessions(stalenessMs: number): StoredSession[];
  touchSession(channelKey: string, sessionId: string): void;
  deactivateSession(channelKey: string, sessionId: string): void;

  // Read-only
  getStats(chatId?: number): MemoryStats | null;
  readCoreKnowledge(): string;
  getLatestCompaction(chatId: number): CompactionResult | null;
  getCronInfo(): CronInfo;
  getConfig(): MemoryConfig;

  // Sleep/maintenance
  gatherSleepState(): SleepStateSnapshot;
  getExtractionWatermark(chatId: number): number;
  setExtractionWatermark(chatId: number, ts: number): void;

  // Dashboard
  searchDashboard(query: string, opts: DashboardSearchOpts): DashboardSearchResult;

  // Heartbeat integration
  setHeartbeat(hb: HeartbeatSystem): void;
  stopHeartbeat(): void;
}
```

**Bridge files change imports:** `MemoryManager` → `IMemorySystem` (type), still construct `MemoryManager` in `bridge-app.ts`.

**Effort:** ~1 hour. Interface file + update imports.

## Phase 0.4: Remove HeartbeatSystem coupling

`MemoryManager` currently imports `HeartbeatSystem` from bridge. This is the tightest coupling.

**Options:**
1. Pass heartbeat as a callback/event emitter instead of concrete class
2. Define a minimal `IHeartbeat` interface in the memory package, bridge implements it

Option 2 is cleaner:
```typescript
// In @agentbridge/memory
export interface IHeartbeat {
  registerTask(task: HeartbeatTask): void;
  unregisterTask(id: string): void;
}
```

Bridge's `HeartbeatSystem` implements `IHeartbeat`. Memory package only knows the interface.

**Effort:** ~30 min.

## Phase 0.5: Extract to standalone package

Move `src/memory/` to a separate package. Two options:

**Option A: Monorepo workspace** (recommended for now)
```
packages/
  memory/
    src/              # all memory files
    cli/              # recall, store, edit, expand, embed, retro-extract
    package.json      # @agentbridge/memory
    tsconfig.json
  bridge/
    src/              # bridge code, imports @agentbridge/memory
    package.json
```

**Option B: Separate repo** (when publishing to npm)
```
~/workspace/agentbridge-memory/    # standalone repo
  src/
  cli/
  package.json                     # @agentbridge/memory
```

Start with Option A (monorepo). Move to Option B when publishing.

**package.json:**
```json
{
  "name": "@agentbridge/memory",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./cli/*": "./dist/cli/*.js"
  },
  "dependencies": {
    "better-sqlite3": "...",
    "ipc-toolkit": "..."
  }
}
```

**Effort:** ~half day. Package setup, build config, import path updates, test migration.

---

## Verification checklist

After Phase 0 is complete:

- [ ] `@agentbridge/memory` builds independently (`npm run build` in package dir)
- [ ] `@agentbridge/memory` has zero imports from bridge code
- [ ] Bridge imports only from `@agentbridge/memory` (no `../memory/` paths)
- [ ] All 20 memory files live in the package
- [ ] All 6 CLIs live in the package and work standalone
- [ ] `getDatabase()` and `getMemoryIndex()` removed from public API
- [ ] `IMemorySystem` interface defined and exported
- [ ] `MemoryManager` implements `IMemorySystem`
- [ ] All 764+ tests pass
- [ ] TypeScript clean (`tsc --noEmit`)

## Implementation order

```
0.1 (internalize utils) → 0.2 (eliminate DB leaks) → 0.3 (interface) → 0.4 (heartbeat) → 0.5 (extract package)
```

Each step is independently committable and testable. No big-bang migration.

## References

- ABM roadmap: `docs/specs/abm-roadmap.md`
- Memory as-built: `docs/asbuilts/memory.asbuilt.md`
- lossless-claw (reference standalone plugin): `~/workspace/lossless-claw`
- OpenClaw memory SDK: `~/workspace/openclaw/packages/memory-host-sdk/`
