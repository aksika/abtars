# #136 Ecosystem Adapters

**Date:** 2026-04-14
**Status:** Planned
**Priority:** LOW
**Depends on:** #138 (done)

## Goal

Make abmind work with every major AI coding tool. MCP config for most hosts. Native plugin for OpenClaw.

## Adapters

| Host | Type | Effort |
|---|---|---|
| kiro-cli | MCP config | 5 min |
| Claude Code | MCP config | 5 min |
| OpenCode / Cursor | MCP config | 5 min |
| OpenClaw | Native plugin (`registerMemoryCapability`) | 1 hr |

## MCP Config Examples

### kiro-cli
```json
{ "mcpServers": { "abmind": { "command": "abmind", "args": ["mcp"] } } }
```

### Claude Code (`.claude/settings.json`)
```json
{ "mcpServers": { "abmind": { "command": "abmind", "args": ["mcp"] } } }
```

## OpenClaw Plugin — Path A (`registerMemoryCapability`)

The modern OC memory plugin API. Old individual methods (`registerMemoryRuntime`, `registerMemoryFlushPlan`, `registerMemoryPromptSection`) are all `@deprecated`.

### What we implement

```typescript
api.registerMemoryCapability({
  promptBuilder,    // → memory.buildWakeUp() → system prompt sections
  flushPlanResolver, // → compaction thresholds + prompt
  runtime,          // → MemorySearchManager backed by abmind recall
});
```

### MemorySearchManager (core contract)

OC expects this interface from the runtime:

```typescript
interface MemorySearchManager {
  search(query, opts?): Promise<MemorySearchResult[]>;
  readFile(params): Promise<{ text: string; path: string }>;
  status(): MemoryProviderStatus;
  sync?(params?): Promise<void>;
  close?(): Promise<void>;
}
```

Map to abmind:
- `search()` → `backend.recall({ translated: [query], chatId: 0, limit: opts.maxResults })`
- `readFile()` → read from `~/.agentbridge/memory/` (daily/weekly files)
- `status()` → `memory.getStats()` mapped to OC's status shape
- `close()` → `memory.close()`

### promptBuilder

```typescript
const promptBuilder: MemoryPromptSectionBuilder = ({ availableTools }) => {
  const wakeup = memory.buildWakeUp(128000);
  return wakeup ? [wakeup] : [];
};
```

### flushPlanResolver

```typescript
const flushPlanResolver: MemoryFlushPlanResolver = () => ({
  softThresholdTokens: 80000,
  forceFlushTranscriptBytes: 200000,
  reserveTokensFloor: 20000,
  prompt: "Summarize the conversation so far.",
  systemPrompt: "You are a conversation summarizer.",
  relativePath: "memory/compaction",
});
```

### Plugin file: `src/adapters/openclaw.ts`

~100 lines. Maps IMemoryCore → OC's MemoryPluginCapability.

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | MCP config examples in `docs/mcp-configs/` | 10 min |
| 2 | OpenClaw plugin: `src/adapters/openclaw.ts` (Path A) | 1 hr |
| 3 | README: "Use with your editor" section | 10 min |
| 4 | Test: kiro-cli MCP + OC plugin load | 15 min |
| **Total** | | **~1.5 hr** |
