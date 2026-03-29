# Memory System Decoupling — Implementation Plan

**Created:** 2026-03-29
**Status:** Not started
**Backlog:** #50

## Vision

Extract the memory system into a standalone `@agentbridge/memory` package — like lossless-claw is to OpenClaw. Any agent framework could use it. Own CLIs, own types, own DB, clean interface.

## Current State

- 15 memory-related source files all in `src/components/`
- 8 bridge files import `MemoryManager` directly
- Two leaky abstractions: `getDatabase()` and `getMemoryIndex()` expose DB internals
- CLIs (recall, store, edit, expand, embed) are tightly coupled to bridge project

## Phase 1: Interface Extraction

Define `IMemorySystem` — the contract between bridge and memory:

```typescript
interface IMemorySystem {
  // Lifecycle
  initialize(): Promise<void>;
  close(): void;

  // Messages
  recordMessage(record: MessageRecord): void;
  loadRecentMessages(chatId: number, sessionId: string, count: number): MessageRecord[];

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

  // Heartbeat integration
  setHeartbeat(hb: HeartbeatSystem): void;
  stopHeartbeat(): void;
}
```

**What disappears from the interface:**
- `getDatabase()` → replaced by `loadRecentMessages()` (session-context)
- `getMemoryIndex()` → recall-engine becomes internal, exposed via `recall()`
- `setLlmCall()` / `setBrowserManager()` / `setIsBusy()` → constructor injection or config
- `checkAutoCompact()` → internal, triggered by `recordMessage()` automatically

**Effort:** ~2-3 hours.

## Phase 2: Eliminate DB Leaks

| Caller | What it does with the DB | Replacement |
|--------|-------------------------|-------------|
| `bridge-app.ts` | Passes to `SleepStateGatherer` | Add `gatherSleepState()` to interface |
| `session-context.ts` | Queries recent messages | `loadRecentMessages()` |
| `bridge-app.ts` | Passes to recall engine | Recall is internal, exposed via `recall()` |

Move SleepStateGatherer inside the memory module.

**Effort:** ~1 hour.

## Phase 3: Directory Reorganization

Move memory files from `src/components/` to `src/memory/`:

```
src/memory/
  index.ts                    # IMemorySystem + MemoryManager export
  memory-manager.ts
  memory-db.ts
  memory-index.ts
  memory-extractor.ts
  recall-engine.ts
  vector-index.ts
  embedding-provider.ts
  ollama-embed.ts
  consolidation-search.ts
  reflection-engine.ts
  ingestion-pipeline.ts
  emotion-utils.ts
  mmr.ts
  sleep-state-gatherer.ts
  types.ts                    # All memory types consolidated
```

Bridge files import from `../memory/index.js` only. Internal files are not re-exported.

**Effort:** ~2 hours (mostly import path updates + tests).

## Phase 4: Extract to Standalone Package

Move `src/memory/` to a separate repo/package. Bridge adds it as a dependency. CLIs (recall, store, edit, expand, embed) move with it.

Package structure (lossless-claw style):
```
@agentbridge/memory/
  index.ts                    # Plugin entry point, IMemorySystem export
  src/                        # All memory internals
  cli/                        # recall, store, edit, expand, embed
  package.json
  tsconfig.json
```

**Effort:** ~half a day. Package setup, build config, publish, update bridge dependency.

## Consumer Dependency Map

| Bridge file | Methods used | Phase 1 impact |
|-------------|-------------|----------------|
| `bridge-app.ts` | initialize, close, getDatabase, getMemoryIndex, getStats, setHeartbeat, setBrowserManager, setIsBusy, setLlmCall | Heaviest — needs getDatabase/getMemoryIndex eliminated (Phase 2) |
| `message-pipeline.ts` | recordMessage, checkAutoCompact, getConfig | checkAutoCompact becomes internal |
| `session-context.ts` | getDb, getLatestCompaction | getDb eliminated (Phase 2) |
| `session-manager.ts` | persistSession, restoreSessions, touchSession, deactivateSession | Clean — already on interface |
| `command-handlers.ts` | getStats, readCoreKnowledge, getCronInfo | Clean |
| `telegram-adapter.ts` | updateEmotionByPlatformId | Clean |
| `discord-adapter.ts` | updateEmotionByPlatformId | Clean |
| `agent-api-server.ts` | recordMessage | Clean |

## Reference

- lossless-claw: `/home/qakosal/workspace/lossless-claw` — standalone context engine plugin for OpenClaw
- CIA-AAA model: `docs/TODO/cia-aaa-memory-model.md`
- Memory as-built: `docs/asbuilts/memory.asbuilt.md`
