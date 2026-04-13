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

## Build & packaging

- `"type": "module"` — ESM only, no CJS fallback
- `"prepare": "tsc"` — auto-builds on `npm install` from git dep
- Exports map in package.json with `.js` extensions everywhere
- `"files": ["dist/"]` — only compiled JS published (when npm publish happens later)

## Dependency strategy (no npm publish)

**Local dev:** `file:../abmind` in bridge's package.json — survives `npm install`, no global symlink fragility.
```json
"abmind": "file:../abmind"
```

**Deploy/CI:** Git dependency pinned to semver tag:
```json
"abmind": "github:aksika/abmind#v0.1.0"
```

**Version pinning:** Semver tags from day one. Never `#main`. Update deliberately via tag bump.

**deploy.sh:** `--quick` skips `npm install`. Git dep updates require full deploy (or explicit `npm install` in deploy dir). Document this.

**Later:** Publish to npm when stable and ready for external users.

## CLI bridge imports (resolved)

CLI files import 4 things from bridge — all have equivalents in memory package:
- `agentBridgeHome` → already in `mem-paths.ts`
- `localISO`, `localMonth` → already in `local-time.ts`
- `EditMemoryParams`, `InstantStoreParams` → move types into abmind

No bridge utilities need duplicating. CLI becomes self-contained.

## MemoryManager split

`MemoryManager` currently lives in `packages/memory/` and implements `IMemorySystem`. After extraction:
- **In abmind:** `MemoryBackend` (core DB operations), `IMemoryCore` interface, all pure memory logic
- **In bridge:** `MemoryManager` wraps abmind's backend + adds bridge-specific methods (heartbeat, emotion by platform ID, cron info). Implements `IMemorySystem extends IMemoryCore`.

## IMemoryCore boundary

`buildWakeUp(ctxWindow)` and `readCoreKnowledge()` stay in `IMemoryCore` — they're useful for any host that needs to inject memory context into prompts (OC, OpenCode, Claude Code all do this). They're not bridge-specific, they're "give me context to put in the prompt."

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | Define `IMemoryCore`, make `IMemorySystem extends IMemoryCore` | 30 min |
| 2 | Create new repo `abmind`, copy source + tests + CLI | 30 min |
| 3 | Set up package.json, tsconfig, vitest, build script | 20 min |
| 4 | Verify all 29 test files pass in new repo | 15 min |
| 5 | Update bridge: git dep, remove `packages/memory/`, update imports | 30 min |
| 6 | Remove deploy symlink hack + update deploy.sh, verify bridge 939 tests pass | 15 min |
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

## Nice-to-haves (not blocking)

- CI in new repo — run 29 test files on push, catch breaks before bridge pulls
- `.github/workflows/test.yml` — simple: checkout, npm install, npm test

## Git history

Start fresh in the new repo. History stays in agentbridge if needed.

## Risk

`SleepDataAccess` is in abmind but deeply used by sleep orchestrator (bridge side). Stays in abmind — it's memory data access. Sleep imports from npm package. Clean boundary.
