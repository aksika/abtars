# #138 abmind MCP Server Adapter

**Date:** 2026-04-14
**Status:** Planned
**Priority:** LOW
**Depends on:** #131 (done)

## Goal

Expose IMemoryCore as MCP tools over stdio. Any MCP-capable host gets persistent memory.

## Tools

| Tool | Params | Returns |
|---|---|---|
| `memory_recall` | `query`, `chatId?` | Search results |
| `memory_store` | `text`, `memoryType`, `chatId?` | `{ id }` |
| `memory_edit` | `memoryId`, `action` (boost/demote) | `{ ok }` |
| `memory_status` | — | Stats |
| `memory_search` | `query` | Substring search results |

## Architecture

```
Host (kiro-cli, Claude Code, OpenCode, Cursor)
  │ MCP (stdio JSON-RPC)
  ▼
abmind mcp
  └── IMemoryCore → 5 tools
```

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | `src/mcp-server.ts` — MCP server with 5 tools | 45 min |
| 2 | `cli/abmind-mcp.ts` — CLI entry: `abmind mcp` | 10 min |
| 3 | Test with kiro-cli MCP config | 15 min |
| **Total** | | **~1 hr** |

## Notes

- Uses `@modelcontextprotocol/sdk` or raw stdio JSON-RPC (TBD based on dependency weight)
- Enterprise kiro-cli with locked MCP registry can't use this — fall back to steering file (#137)
- MCP is the best UX path (structured tools, no bash parsing)
