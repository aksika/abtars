# #136 Ecosystem Adapters

**Date:** 2026-04-14
**Status:** Planned
**Priority:** LOW
**Depends on:** #138 (MCP server)

## Goal

Make abmind work with every major AI coding tool. Most hosts just need an MCP config entry pointing to `abmind mcp`.

## Adapters

| Host | Type | Effort | Notes |
|---|---|---|---|
| kiro-cli | MCP config | 5 min | `.kiro/settings/lsp.json` mcpServers entry |
| Claude Code | MCP config | 5 min | `.claude/settings.json` |
| OpenCode | MCP config | 5 min | MCP config |
| Cursor | MCP config | 5 min | MCP config |
| OpenClaw | Native plugin | 1 hr | `register(api)` with registerTool, hooks |

## Key Insight

#138 (MCP server) makes most adapters trivial — just a config file. Only OpenClaw needs a native plugin because it has its own plugin API.

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | MCP config examples: kiro-cli, Claude Code, OpenCode, Cursor | 15 min |
| 2 | OpenClaw plugin: `src/adapters/openclaw.ts` | 45 min |
| 3 | README: "How to use abmind with your editor" section | 15 min |
| **Total** | | **~1.5 hr** |

## MCP Config Example (kiro-cli)

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

## OpenClaw Plugin

```typescript
export function register(api: OpenClawAPI): void {
  api.registerTool("memory_recall", { ... });
  api.registerTool("memory_store", { ... });
  api.registerContextEngine("abmind", { ... });
  api.hooks.onMessage(async (msg) => { ... });
}
```

~50-100 lines. Maps IMemoryCore methods to OC's registerTool/hooks API.

## Execution Order

#138 (MCP server) → #136 (adapters use it)
