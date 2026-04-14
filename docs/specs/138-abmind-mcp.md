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
| `memory_recall` | `query`, `userId?` (default "default") | Full 4-layer search results (FTS5 + trigram + semantic + consolidated) |
| `memory_store` | `text`, `memoryType` (fact/preference/decision/event), `userId?` (default "default") | `{ id }` |
| `memory_edit` | `memoryId`, `action` (boost/demote) | `{ ok }` — v1 scope, more actions later |
| `memory_status` | `userId?` | Stats (total messages, memories, db size) |
| `memory_wakeup` | `ctxWindowSize?` (default 128000), `userId?` | Wake-up context string for session start |

5 tools. No `memory_search` — recall covers all search layers.

### userId

- Default: `"default"` — single-user, unscoped
- Multi-user: each person gets their own memory scope
- Internally maps `userId` → `chatId` (when #67 ships, mapping becomes real; until then `"default"` → `0`)
- MCP hosts don't have a natural chat/user ID — this keeps it simple

### Error handling

MCP SDK structured errors:
- DB locked → `InternalError` with message
- Invalid memory ID → `InvalidParams`
- Ollama down (embeddings) → `InternalError` with "embedding service unavailable"

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
| 1 | `npm install @modelcontextprotocol/sdk` | 5 min |
| 2 | `src/mcp-server.ts` — MCP server with 5 tools | 40 min |
| 3 | `cli/abmind-mcp.ts` — CLI entry: `abmind mcp` | 10 min |
| 4 | Test with kiro-cli MCP config | 15 min |
| 5 | Test with Claude Code MCP config | 10 min |
| **Total** | | **~1.5 hr** |

## Notes

- Uses `@modelcontextprotocol/sdk` — handles protocol negotiation, tool listing, content types
- Enterprise kiro-cli with locked MCP registry can't use this — fall back to steering file (#137)
- MCP is the best UX path (structured tools, no bash parsing)
