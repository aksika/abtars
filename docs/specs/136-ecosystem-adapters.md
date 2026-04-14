# #136 Ecosystem Adapters

**Date:** 2026-04-14
**Status:** Planned
**Priority:** LOW
**Depends on:** #138 (done), #146 (done — user_id in schema), #67 Phase 0 (done — users.json)

## Goal

Make abmind work with every major AI coding tool. MCP config for most hosts. Native plugin for OpenClaw.

## Pre-req fixes (part of this ticket)

### 1. `ABMIND_HOME` — standalone home dir

abmind gets its own home dir, decoupled from agentbridge:

```
Standalone:  ABMIND_HOME=~/.abmind              (default)
With bridge: ABMIND_HOME=~/.agentbridge/memory   (bridge overrides via env)
```

Rename `agentBridgeHome()` → `abmindHome()` in abmind repo. Reads `ABMIND_HOME` env var, defaults to `~/.abmind`.

### 2. `buildWakeUp()` — simplify param

Replace `buildWakeUp(ctxWindowSize: number)` with `buildWakeUp(maxChars?: number)`. Default ~5000 chars. No model context window knowledge needed.

### 3. MCP server `memory_wakeup` — simplify param

Tool accepts `maxChars` (optional) instead of `ctxWindowSize`. Default 5000.

### 4. MCP server userId — master from users.json

If no `userId` param from client → read master from `users.json` (via `loadMasterUserId()`). Remove `userIdToChatId()` hash function.

## User resolution

All adapters resolve the master userId at runtime from `~/.agentbridge/config/users.json`:

```typescript
const usersPath = join(agentBridgeHome(), "config", "users.json");
```

Fallback: if no `users.json` exists (standalone, no bridge), default to `"default"`.

Never hardcode a userId. The master is whoever `users.json` says it is.

## MCP Config

One JSON snippet, same for all hosts. Put in your host's MCP config file:

```json
{ "mcpServers": { "abmind": { "command": "abmind", "args": ["mcp"] } } }
```

| Host | Where to put it |
|---|---|
| kiro-cli | `.kiro/settings/mcp.json` or `kiro-cli mcp add` |
| Claude Code | `.claude/settings.json` |
| OpenCode / Cursor | Host's MCP config |

## OpenClaw Plugin — `registerMemoryCapability`

### Entry point

```typescript
export async function register(api: OpenClawPluginApi): Promise<void> {
  const config = loadMemoryConfig();
  const memory = new MemoryManager(config);
  await memory.initialize();
  const backend = await createMemoryBackend(config);
  const masterUserId = loadMasterUserId();

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
| `search(query, opts?)` | `backend.recall({ translated: [query], chatId: 0, limit: opts.maxResults })` — filtered by `user_id = masterUserId` |
| `readFile({ relPath })` | Read from `abmindHome()`. Return `{ text: "", path }` if missing |
| `status()` | `memory.getStats()` mapped to OC's shape |
| `sync()` | No-op — SQLite writes are immediate |
| `close()` | `memory.close()` |

### promptBuilder

```typescript
const promptBuilder: MemoryPromptSectionBuilder = () => {
  const wakeup = memory.buildWakeUp();
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
| 1 | `ABMIND_HOME` — rename `agentBridgeHome()` → `abmindHome()`, default `~/.abmind` | 15 min |
| 2 | `buildWakeUp(maxChars?)` — replace `ctxWindowSize` param, default 5000, update all callers | 10 min |
| 3 | Fix MCP server — remove `ctxWindowSize` from wakeup tool, master userId from users.json | 15 min |
| 4 | `loadMasterUserId()` helper — reads users.json, finds master | 5 min |
| 5 | OpenClaw plugin: `src/adapters/openclaw.ts` | 45 min |
| 6 | README: "Use with your editor" section + MCP config snippet | 10 min |
| 7 | Test | 15 min |
| **Total** | | **~2 hr** |
