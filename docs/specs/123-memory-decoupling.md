# #123 Memory Decoupling — Implementation Plan

**Status:** Planned
**Priority:** HIGH
**Prerequisite for:** #124 (Universal CLI), #125 (MCP Server), #126 (OpenClaw Plugin)
**Spec:** [memory-decoupling.plan.md](memory-decoupling.plan.md)

## Current state

### Already done
- ✅ `mem-logger.ts`, `mem-paths.ts` internalized (memory has its own logger + paths)
- ✅ `IMemorySystem` interface with full contract (50+ methods)
- ✅ `IHeartbeat` interface — bridge implements it, memory only knows the contract
- ✅ `mem-types.ts` self-contained, `index.ts` single entry point
- ✅ Maintenance methods on interface (`runWalCheckpoint`, `rebuildFtsIndexes`, `cleanupOldMessages`, `backfillEmbeddings`, `deduplicateMessages`, `fixMemoryDefaults`)
- ✅ `SleepStateGatherer` lives in `src/memory/`

### Remaining coupling

**1 bridge import from memory files:**
| Import | Used by |
|---|---|
| `../utils/local-time.js` | 8 memory files (compressor, editor, recall-engine, session-context, sleep-state-gatherer, timeline-builder, trigram-search, wake-up-builder) |

**3 callers use `memory.getDatabase()` (raw DB leak):**
| Caller | What it does |
|---|---|
| `message-pipeline.ts:473` | Passes raw DB to `buildWakeUp()` |
| `agentbridge-sleep.ts:785` | Passes raw DB to `buildCandidateLists()`, emotion arc builder, watermarks, message cleanup |
| `memory-search-controller.ts:95` | Passes raw DB + index to `recallSearch()` |

**4 callers use `memory.store.*` (internal sub-object leak):**
| Caller | Methods accessed |
|---|---|
| `memory-search-controller.ts` | `.store.getDistinctChatIds()`, `.store.getAllExtractedMemories()`, `.store.getAllEntities()`, `.store.getAllEntityLinks()` |

**2 memory-internal files take `MemoryManager` instead of `IMemorySystem`:**
| File | Signature |
|---|---|
| `session-context.ts:36` | `buildSessionStartContext(memory: MemoryManager, chatId)` |
| `sleep-state-gatherer.ts:67` | `constructor(memory: MemoryManager, ...)` — calls `memory.getDatabase()` |

**`recallSearch()` takes raw `{db, index}` deps:**
| File | Signature |
|---|---|
| `recall-engine.ts:73` | `RecallDeps = { db: Database.Database; index: MemoryIndex; ... }` |

---

## Implementation steps

### Step 1: Copy `local-time.ts` into memory (5 min)
Copy `src/utils/local-time.ts` → `src/memory/local-time.ts` (28 lines, 5 pure functions). Update 8 imports. Bridge keeps its copy. **Result: zero `../` imports from memory files.**

### Step 2: Add `buildWakeUp` to IMemorySystem (15 min)
Add to interface:
```typescript
buildWakeUp(ctxWindowSize: number): string;
```
`MemoryManager` implements by calling existing `buildWakeUp(this.db, ctxWindowSize)`.
Pipeline changes: `memory.buildWakeUp(ctxWindow)` instead of `buildWakeUp(memory.getDatabase(), ctxWindow)`.

**1 new method, 1 caller fixed.**

### Step 3: Add dashboard methods to IMemorySystem (30 min)
Add to interface:
```typescript
getDistinctChatIds(): number[];
getAllExtractedMemories(): ExtractedMemory[];
getAllEntities(): Entity[];
getAllEntityLinks(): EntityLink[];
recallSearch(params: RecallParams): Promise<RecallResult>;
```
`MemoryManager` delegates to `this.store.*` and `recallSearch({db: this.db, index: this.memoryIndex, ...}, params)`.
`memory-search-controller.ts` calls `memory.recallSearch(params)` instead of importing recall-engine + passing raw DB.

**5 new methods, 1 caller fixed. Removes `getMemoryIndex()` leak.**

### Step 4: Move sleep raw SQL into memory package (45 min)

Sleep has 13 raw `db.` calls outside the existing maintenance methods. They fall into 3 groups:

**Group A: `buildCandidateLists()`** — 6 queries (untagged, promote, merge sigs, translation, emotion gaps, recall feedback). Already a self-contained function. Move to `src/memory/sleep-candidates.ts`. Expose via interface:
```typescript
buildSleepCandidates(): SleepCandidateLists;
```

**Group B: Emotion arc building** — 4 queries (get topics, get memories per topic, find target, update arc). Move to `src/memory/emotion-arc.ts` (file exists, `buildArc()` already there). Add:
```typescript
buildAndStoreEmotionArcs(): { updated: number };
```

**Group C: Watermarks + chatId + messages** — 3 queries. Already partially covered:
- `getDistinctChatIds()` → added in Step 3
- Watermark read/write → add `getExtractionWatermark(chatId)` / `setExtractionWatermark(chatId, ts)` to interface
- Recent messages for extraction → `loadRecentMessages()` already on interface

**Message cleanup (lines 1091-1151)** — 6 queries for garbage/age/cap cleanup. Already covered by `cleanupOldMessages()` on interface. Sleep should call that instead of raw SQL.

**3 new methods, ~13 raw queries eliminated.**

### Step 5: Switch bridge files from MemoryManager → IMemorySystem (30 min)

11 bridge files import `MemoryManager` as a type. Switch to `IMemorySystem`:

| File | Import type |
|---|---|
| `capability.ts` | type |
| `compaction.ts` | type |
| `daily-cycle.ts` | type |
| `heartbeat-tasks.ts` | type |
| `memory-search-controller.ts` | type |
| `message-pipeline.ts` | type |
| `discord-adapter.ts` | type |
| `telegram-adapter.ts` | type |
| `agent-api-server.ts` | concrete → type |

Keep concrete `MemoryManager` import in:
- `bridge-app.ts` — composition root, constructs the instance
- `agentbridge-sleep.ts` — sleep subprocess, constructs its own instance

Also fix memory-internal files:
- `session-context.ts`: change `MemoryManager` → `IMemorySystem` in signature
- `sleep-state-gatherer.ts`: change constructor to accept `IMemorySystem`, use interface methods instead of `getDatabase()`

### Step 6: Add 3 missing exports to index.ts (5 min)

These memory modules are imported by bridge code but not re-exported from `index.ts`:
- `sanitizeForSummary` from `media-sanitizer.ts` (used by sleep-daily-summary)
- `loadEmbedConfig`, `batchEmbed` from `ollama-embed.ts` (used by CLI)
- `buildMemoryContext` from `session-memory.ts` (used by compaction)

Add to `index.ts`. After this, all bridge → memory imports can go through the package entry point.

### Step 7: Make `getDatabase()` / `getMemoryIndex()` private (10 min)
After steps 2-6, no external caller needs raw DB. Make them `private`. TypeScript compiler catches any missed callers.

### Step 8: Package extraction (2 hr)
```
packages/
  memory/
    src/           ← all src/memory/* files
    package.json   ← @agentbridge/memory
    tsconfig.json
  bridge/
    src/           ← everything else
    package.json   ← depends on @agentbridge/memory
```
npm workspace linking. Separate build. CLIs (`agentbridge-recall`, `agentbridge-store`, `agentbridge-edit`, `agentbridge-embed`, `agentbridge-expand`, `agentbridge-retro-extract`, `agentbridge-backfill-v2`) move into the memory package. All 900 tests pass.

---

## Summary

| Step | What | Time | Methods added |
|---|---|---|---|
| 1 | Copy local-time.ts | 5 min | 0 |
| 2 | buildWakeUp on interface | 15 min | 1 |
| 3 | Dashboard methods on interface | 30 min | 5 |
| 4 | Sleep SQL → memory package | 45 min | 3 |
| 5 | Switch MemoryManager → IMemorySystem | 30 min | 0 |
| 6 | Add 3 missing exports to index.ts | 5 min | 0 |
| 7 | Make getDatabase() private | 10 min | 0 |
| 8 | Package extraction | 2 hr | 0 |
| **Total** | | **~4 hr** | **9 new methods** |

Steps 1-7 ship independently on `main` — pure improvements, no structural change. Step 8 is the monorepo move.

## Not in scope
- Sleep orchestrator rewrite (#4 partial) — separate item
- Transport profiles → transport.json (#118) — separate item
- Unified subagent factory (#122) — separate item
- Universal CLI (#124), MCP server (#125), OpenClaw plugin (#126) — depend on this
