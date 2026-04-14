# #136 Ecosystem Adapters

**Date:** 2026-04-14
**Status:** Planned
**Priority:** LOW
**Depends on:** #138 (done), #146 (done — user_id in schema), #67 Phase 0 (done — users.json)

## Goal

Make abmind work with every major AI coding tool. MCP config for most hosts. Native plugin for OpenClaw.

## User resolution

All adapters resolve the master userId at runtime from `~/.agentbridge/users.json`:

```typescript
const users = JSON.parse(readFileSync(join(agentBridgeHome(), "users.json"), "utf-8"));
const master = users.users.find((u: { role: string }) => u.role === "master");
const masterUserId = master.userId;
```

Never hardcode `"aksika"`. The master is whoever `users.json` says it is.

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

### MCP server fix (pre-req)

`src/mcp-server.ts` currently uses `userIdToChatId()` with a hash. Update:
- If no `userId` param from client → read master from `users.json`
- Pass `userId` to backend calls (backend scopes by user_id column)

## OpenClaw Plugin — `registerMemoryCapability`

### Entry point

```typescript
export async function register(api: OpenClawPluginApi): Promise<void> {
  const config = loadMemoryConfig();
  const memory = new MemoryManager(config);
  await memory.initialize();
  const backend = await createMemoryBackend(config);
  const masterUserId = loadMasterUserId(); // from users.json

  api.registerMemoryCapability({
    promptBuilder,
    flushPlanResolver,
    runtime: buildRuntime(backend, memory, masterUserId, api),
  });
}
```

### MemorySearchManager mapping

| OC method | abmind mapping |
|---|---|
| `search(query, opts?)` | `backend.recall({ translated: [query], chatId: 0, limit: opts.maxResults })` — scoped by master userId |
| `readFile({ relPath })` | Read from `~/.agentbridge/memory/`. Return `{ text: "", path }` if missing |
| `status()` | `memory.getStats()` mapped to OC's shape |
| `sync()` | No-op — SQLite writes are immediate |
| `close()` | `memory.close()` |

### promptBuilder

```typescript
const promptBuilder: MemoryPromptSectionBuilder = () => {
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

### Error handling

- DB locked / missing → return empty results, log via `api.logger.error()`
- Never throw from search/status — degrade gracefully

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | Fix MCP server — master userId from users.json, pass userId to backend | 15 min |
| 2 | MCP config examples in `docs/mcp-configs/` | 10 min |
| 3 | `loadMasterUserId()` helper — reads users.json, finds master | 5 min |
| 4 | OpenClaw plugin: `src/adapters/openclaw.ts` | 45 min |
| 5 | README: "Use with your editor" section | 10 min |
| 6 | Test: kiro-cli MCP + OC plugin load | 15 min |
| **Total** | | **~1.5 hr** |
