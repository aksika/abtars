# #136 Ecosystem Adapters

**Date:** 2026-04-14
**Status:** Planned
**Priority:** LOW
**Depends on:** #138 (done)

## Goal

Make abmind work with every major AI coding tool. Most hosts just need an MCP config entry. OpenClaw gets a native plugin.

## Adapters

| Host | Type | Effort | Notes |
|---|---|---|---|
| kiro-cli | MCP config | 5 min | `.kiro/settings/mcp.json` or `kiro-cli mcp add` |
| Claude Code | MCP config | 5 min | `.claude/settings.json` mcpServers |
| OpenCode | MCP config | 5 min | MCP config |
| Cursor | MCP config | 5 min | MCP config |
| OpenClaw | Native plugin | 45 min | `registerTool` + `registerHook` |

## MCP Config Examples

### kiro-cli
```json
{
  "mcpServers": {
    "abmind": {
      "command": "abmind",
      "args": ["mcp"],
      "scope": "workspace"
    }
  }
}
```

### Claude Code (`.claude/settings.json`)
```json
{
  "mcpServers": {
    "abmind": {
      "command": "abmind",
      "args": ["mcp"]
    }
  }
}
```

### Cursor / OpenCode
Same pattern — `abmind mcp` as stdio MCP server.

## OpenClaw Plugin

Two integration paths available:

**Path B (chosen for v1): `registerTool` + `registerHook`**
- Additive — doesn't replace OC's built-in memory
- Register `memory_recall`, `memory_store` as agent tools
- Hook `onConversationBindingResolved` for auto-recall on session start
- ~50 lines

**Path A (future): `registerMemoryCapability`**
- Full replacement — abmind becomes OC's memory system
- Implements `MemoryPluginCapability` (promptBuilder, flushPlanResolver, runtime)
- Much deeper integration, bigger commitment
- Deferred until demand exists

### Plugin structure (Path B)

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { loadMemoryConfig } from "abmind/memory-config.js";
import { MemoryManager } from "abmind/memory-manager.js";
import { createMemoryBackend } from "abmind/backend-factory.js";

export async function register(api: OpenClawPluginApi): Promise<void> {
  const config = loadMemoryConfig();
  const memory = new MemoryManager(config);
  await memory.initialize();
  const backend = await createMemoryBackend(config);

  api.registerTool({
    name: "memory_recall",
    description: "Search persistent memory",
    parameters: { query: { type: "string" } },
    async execute({ query }) {
      const result = await backend.recall({ chatId: 0, translated: [query], limit: 10 });
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "memory_store",
    description: "Store a memory",
    parameters: { text: { type: "string" }, memoryType: { type: "string" } },
    async execute({ text, memoryType }) {
      const result = await backend.instantStore({
        chatId: 0, contentEn: text, contentOriginal: text,
        memoryType, emotionScore: 0,
      });
      return JSON.stringify(result);
    },
  });

  api.on("beforePrompt", async ({ conversationId }) => {
    // Inject wake-up context at session start
    const wakeup = memory.buildWakeUp(128000);
    if (wakeup) api.logger.info(`[abmind] Wake-up context injected (${wakeup.length} chars)`);
  });
}
```

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | MCP config examples in `docs/mcp-configs/` | 15 min |
| 2 | OpenClaw plugin: `src/adapters/openclaw.ts` (Path B) | 45 min |
| 3 | README: "Use with your editor" section | 10 min |
| 4 | Test: kiro-cli + one other host | 15 min |
| **Total** | | **~1.5 hr** |

## Execution Order

#138 (MCP server, done) → #136 (this)
