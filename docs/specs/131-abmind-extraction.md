# #131 Extract abmind to Separate Repo

**Date:** 2026-04-13
**Status:** Planned
**Priority:** MEDIUM
**Depends on:** nothing
**Blocks:** #132, #133, #136

## Goal

Extract the memory package to its own repo. Bridge imports it as a git dependency. No npm publish yet.

## What moves to new repo

- `packages/memory/src/` — 38 source files (~10.5K lines)
- `packages/memory/src/*.test.ts` — 29 test files (~4.7K lines)
- `src/cli/abmind.ts` + all `src/cli/abmind-*.ts` subcommands

## External deps (minimal)

- `better-sqlite3` — only real dependency
- `fast-check` — dev only (property-based tests)
- Node built-ins: `fs`, `path`, `os`, `net`

## IMemoryCore (public API)

What external consumers see:

```typescript
interface IMemoryCore {
  initialize(): Promise<void>;
  close(): void;

  recall(query: string, opts?: RecallOptions): Promise<RecallResult>;
  store(text: string, type: string, meta?: StoreMeta): Promise<number>;
  edit(id: number, changes: EditChanges): Promise<void>;
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;

  buildWakeUp(ctxWindow: number): string;
  readCoreKnowledge(): string;
  stats(): MemoryStats;
}
```

## IMemorySystem (bridge-internal)

Extends IMemoryCore with bridge-specific methods:
- `recordMessage()`, `loadRecentMessages()` — message tracking
- `setHeartbeat()`, `stopHeartbeat()` — heartbeat integration
- `getSleepData()` — sleep cycle access
- `setLlmCall()` — LLM callback for maintenance
- Maintenance: rebuild FTS, cleanup, dedup, backfill
- Emotion: `updateEmotionByPlatformId()`

## What stays in bridge

- `src/memory/memory-manager.ts` — implements `IMemorySystem`, wraps abmind's `MemoryBackend`
- `src/memory/imemory-system.ts` — re-exports `IMemoryCore` from abmind + adds bridge methods
- Sleep orchestrator (`src/capabilities/sleep/`) — imports `SleepDataAccess` from abmind

## Dependency strategy (no npm publish)

**Local dev:** `npm link` between repos — changes in abmind are instant in bridge.
```bash
cd ~/workspace/abmind && npm link
cd ~/workspace/agentbridge && npm link abmind
```

**Deploy/CI:** Git dependency in bridge's package.json:
```json
"abmind": "github:aksika/abmind#main"
```

**Later:** Publish to npm when stable and ready for external users.

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | Define `IMemoryCore`, make `IMemorySystem extends IMemoryCore` | 30 min |
| 2 | Create new repo `abmind`, copy source + tests + CLI | 30 min |
| 3 | Set up package.json, tsconfig, vitest, build script | 20 min |
| 4 | Verify all 29 test files pass in new repo | 15 min |
| 5 | Update bridge: git dep, remove `packages/memory/`, update imports | 30 min |
| 6 | Remove deploy symlink hack, verify bridge 939 tests pass | 15 min |
| 7 | Write `.kiro/steering/abmind.md` for standalone use | 15 min |
| **Total** | | **~2.5 hr** |

## Bridge import changes

Before (symlink):
```typescript
import { MemoryManager } from "abmind/memory-manager.js";  // → packages/memory/src/
```

After (git dep):
```typescript
import { MemoryManager } from "abmind/memory-manager.js";  // → node_modules/abmind/
```

Import paths stay the same. Only the resolution changes.

## Risk

`SleepDataAccess` is in abmind but deeply used by sleep orchestrator (bridge side). Stays in abmind — it's memory data access. Sleep imports from npm package. Clean boundary.
