# Claude Code Architecture Study — Direct API Transport Reference

> Studied: 2026-04-06. Source: `~/workspace/claude-code/src/`

## Relevant Architecture

| Layer | File | Lines | Purpose |
|---|---|---|---|
| Tool type | `Tool.ts` | 792 | Schema (Zod), call(), permissions, concurrency, read-only flags |
| Tool registry | `tools.ts` | ~200 | Feature-gated tool registration, conditional requires |
| API client | `services/api/claude.ts` | 3419 | Anthropic API, streaming, retry, cache, model routing |
| Query loop | `query.ts` | 1729 | The agent loop — send → stream → execute tools → repeat |
| Tool executor | `services/tools/StreamingToolExecutor.ts` | 530 | Parallel execution, abort, progress tracking |
| System prompt | `utils/queryContext.ts` | ~150 | Assembles system prompt from parts (context, memory, skills) |

## Query Loop (`query.ts`)

Core pattern — `queryLoop()` is a `while(true)`:

```
1. Build API request (messages + system prompt + tool schemas)
2. Stream response via queryModel() (SSE)
3. Yield chunks for UI rendering
4. If response has tool_use blocks:
   a. StreamingToolExecutor runs tools (parallel where safe)
   b. Append tool results to messages
   c. Continue loop (back to step 1)
5. If no tool_use → done, return terminal state
```

The 1729 lines handle edge cases:
- Auto-compaction mid-conversation (reactive compact when context fills)
- Streaming tool execution with abort/cancel signals
- Error recovery: retry on transient, abort on fatal
- Permission handling (ask user, deny, allow)
- Concurrent tool execution with sibling abort
- Token budget tracking
- Memory prefetch (async, non-blocking)
- Max turns limit
- Stop hooks (custom stop conditions)

## Tool Definition Pattern

```typescript
type Tool<Input, Output> = {
  name: string;
  inputSchema: ZodSchema;          // Zod schema → converted to JSON Schema for API
  inputJSONSchema?: JSONSchema;     // Or raw JSON Schema (MCP tools)
  call(args, context): Promise<ToolResult>;
  description(input, options): Promise<string>;  // Dynamic description
  isEnabled(): boolean;
  isReadOnly(input): boolean;
  isConcurrencySafe(input): boolean;
  isDestructive?(input): boolean;
  interruptBehavior?(): 'cancel' | 'block';
}
```

`toolToAPISchema()` converts Tool → Anthropic API format. Caches per session.

## Streaming

`queryModelWithStreaming()` returns `AsyncGenerator<StreamEvent>`. Events:
- `content_block_delta` with `text_delta` → text chunks
- `content_block_start` with `tool_use` → tool call starting
- `content_block_delta` with `input_json_delta` → tool input streaming
- `message_delta` with `stop_reason` → turn complete

## What We Can Borrow

1. **Query loop pattern** — while(true) { send → stream → tools → loop }. Our version is simpler (sequential tools, no concurrent execution).
2. **Tool schema generation** — convert internal definitions to API format. We'd use OpenAI format instead of Anthropic.
3. **Streaming chunk emission** — parse SSE, yield text deltas. Our pipeline already consumes chunks.
4. **Abort via AbortController** — pass signal to fetch, tool execution checks signal.
5. **Auto-compact inside loop** — check token usage after each turn, compact if needed.

## What We Don't Need

- Concurrent tool execution (our tools are sequential bash calls)
- Complex permission UI (we auto-approve)
- 3400-line API client (simple fetch + SSE parser)
- Zod schema system (our tools are CLI-based, schemas are static)
- Memory prefetch (our memory is local SQLite, not async)
- Stop hooks, budget tracking, max output token recovery
