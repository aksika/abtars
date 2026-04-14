# #136 Ecosystem Adapters

**Date:** 2026-04-14
**Status:** Planned
**Priority:** LOW
**Depends on:** #138 (done — abmind v0.4.0)

## Goal

Make abmind work with every major AI coding tool. MCP config for most hosts. Native plugin for OpenClaw.

## Adapters

| Host | Type | Effort |
|---|---|---|
| kiro-cli | MCP config | 5 min |
| Claude Code | MCP config | 5 min |
| OpenCode / Cursor | MCP config | 5 min |
| OpenClaw | Native plugin (`registerMemoryCapability`) | 1 hr |

## MCP Configs

All MCP hosts use the same config — only the file location differs:

```json
{ "mcpServers": { "abmind": { "command": "abmind", "args": ["mcp"] } } }
```

| Host | Config file |
|---|---|
| kiro-cli | `.kiro/settings/mcp.json` or `kiro-cli mcp add` |
| Claude Code | `.claude/settings.json` |
| OpenCode | MCP config |
| Cursor | MCP config |

## OpenClaw Plugin — `registerMemoryCapability`

The modern OC memory plugin API. Old individual methods are `@deprecated`.

### Entry point

```typescript
export async function register(api: OpenClawPluginApi): Promise<void> {
  const config = loadMemoryConfig();
  const memory = new MemoryManager(config);
  await memory.initialize();
  const backend = await createMemoryBackend(config);

  api.registerMemoryCapability({
    promptBuilder,
    flushPlanResolver,
    runtime: buildRuntime(backend, memory, api),
  });
}
```

### MemorySearchManager mapping

| OC method | abmind mapping | Notes |
|---|---|---|
| `search(query, opts?)` | `backend.recall({ translated: [query], chatId: 0, limit: opts.maxResults })` | chatId 0 for now; map from OC's `agentId` when #67 ships |
| `readFile({ relPath, from?, lines? })` | Read from abmind data dir (`~/.agentbridge/memory/`). Return `{ text: "", path }` if file doesn't exist | relPath is relative to memory data dir |
| `status()` | `memory.getStats()` mapped to OC's `MemoryProviderStatus` shape | |
| `sync()` | No-op — SQLite writes are immediate, no sync needed | |
| `close()` | `memory.close()` | |

### promptBuilder

```typescript
const promptBuilder: MemoryPromptSectionBuilder = ({ availableTools }) => {
  // Use OC's model context window if available, fallback to 128k
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
  relativePath: "memory/compaction", // relative to OC's workspace dir
});
```

### Error handling

- DB locked / missing → return empty results, log via `api.logger.error()`
- Never throw from search/status — OC should degrade gracefully
- Wrap all backend calls in try/catch

### chatId / userId

- Hardcoded `0` for now (single-user)
- OC provides `agentId` in runtime params — can map to userId when #67 ships
- Note in code: `// TODO(#67): map agentId → userId`

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | MCP config examples in `docs/mcp-configs/` | 10 min |
| 2 | OpenClaw plugin: `src/adapters/openclaw.ts` | 1 hr |
| 3 | README: "Use with your editor" section | 10 min |
| 4 | Test: kiro-cli MCP + OC plugin load | 15 min |
| **Total** | | **~1.5 hr** |
