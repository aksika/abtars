# Direct API Transport — Design Document

> Status: Design phase. Backlog #69.
> References: Claude Code study (`docs/studies/claude-code-direct-api-study.md`), Hermes Agent, 9Router audit.

## Goal

New `IKiroTransport` implementation that talks directly to any OpenAI-compatible API endpoint. No CLI dependency. The bridge becomes a fully self-contained agent.

## Architecture

```
User message (Telegram/Discord)
  │
  ▼
message-pipeline.ts (unchanged)
  │
  ▼
DirectApiTransport.sendPrompt(sessionKey, message)
  │
  ├── Build messages array (system prompt + conversation history + new message)
  ├── Build tool schemas (from tool registry)
  │
  ▼
  ┌─────────────────────────────────────────┐
  │  Agent Loop (while true)                │
  │                                         │
  │  1. POST /v1/chat/completions (stream)  │
  │  2. Parse SSE → emit chunks             │
  │     → pipeline delivers to Telegram     │
  │  3. If tool_calls in response:          │
  │     a. Execute each tool                │
  │     b. Append results to messages       │
  │     c. Continue loop                    │
  │  4. If no tool_calls → return content   │
  └─────────────────────────────────────────┘
  │
  ▼
Pipeline delivers final response to user
```

## Components

### 1. DirectApiTransport (`src/components/transport/direct-api-transport.ts`)

Implements `IKiroTransport`. ~200 lines.

```typescript
class DirectApiTransport implements IKiroTransport {
  private sessions = new Map<string, ConversationSession>();
  private abortControllers = new Map<string, AbortController>();

  async initialize(): Promise<void>;
  async sendPrompt(sessionKey: string, message: string): Promise<string>;
  async resetSession(sessionKey: string): Promise<void>;
  async destroy(): Promise<void>;

  // Streaming — same interface as AcpTransport
  onChunk?: (sessionKey: string, text: string) => void;

  // Context tracking
  get contextPercent(): number;
  get isReady(): boolean;
}
```

**sendPrompt() flow:**
1. Get or create `ConversationSession` for sessionKey
2. Append user message to session history
3. Enter agent loop:
   - Call `streamCompletion()` with messages + tools
   - Accumulate text chunks, emit via `onChunk`
   - If response has `tool_calls` → execute via tool registry → append results → loop
   - If response has content only → append assistant message → return content
4. Update `contextPercent` from `usage.prompt_tokens / maxContextTokens`

### 2. ConversationSession (`src/components/transport/conversation-session.ts`)

Per-session conversation state. ~80 lines.

```typescript
type ConversationSession = {
  messages: ChatMessage[];        // Full conversation history
  systemPrompt: string;           // SOUL + skills + context
  totalTokens: number;            // Running token count from API responses
  maxTokens: number;              // Model's context window size
}

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];        // Assistant requesting tool execution
  tool_call_id?: string;          // Tool result referencing the call
  name?: string;                  // Tool name for tool results
}
```

### 3. SSE Stream Parser (`src/components/transport/sse-parser.ts`)

Parse OpenAI streaming responses. ~60 lines.

```typescript
async function* parseSSEStream(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<SSEEvent> {
  // Read response body as text stream
  // Parse "data: {...}" lines
  // Yield: { type: 'chunk', content: string }
  //        { type: 'tool_call', id, name, arguments }
  //        { type: 'done', usage: { prompt_tokens, completion_tokens } }
}
```

### 4. Tool Registry (`src/components/transport/tool-registry.ts`)

Maps agentbridge-* CLIs to OpenAI function-calling schemas. ~100 lines.

```typescript
type ToolDefinition = {
  name: string;
  description: string;
  parameters: JSONSchema;           // OpenAI function parameters
  execute: (args: Record<string, string>) => Promise<string>;
}

function buildToolSchemas(): ToolDefinition[];
function executeToolCall(name: string, args: Record<string, string>): Promise<string>;
```

**Tool definitions generated from:**
- `agentbridge-store` → store memories
- `agentbridge-recall` → search memories
- `agentbridge-edit` → edit memories
- `agentbridge-browse` → browse web (via IPC)
- `agentbridge-browser` → direct browser actions
- `agentbridge-todo` → manage todos
- `agentbridge-task` → manage cron tasks
- `execute_bash` → run shell commands (the big one)

**execute_bash is the universal tool.** The agent can do anything via bash — read files, write files, run commands, call other CLIs. The other tools are shortcuts for common operations. This matches how kiro-cli works today.

### 5. System Prompt Builder

Reuses existing `soul-loader.ts` + `session-memory.ts`. The system prompt is:

```
[SOUL.md content]
[TOOLS.md content]
[user_profile.md content]
[agent_notes.md content]

[Session context — recent memories, daily summary, todos]
```

Injected as `role: 'system'` message (first in array). Already built by `loadSoulBundle()` and `buildSessionMemoryContext()`.

## Config

```env
AGENT_TRANSPORT=api                              # Select direct API transport
API_ENDPOINT=http://localhost:20128/v1           # 9Router, OpenRouter, or any OpenAI-compatible
API_KEY=sk-...                                   # API key (optional for 9Router)
API_MODEL=kimi-k2                                # Model name
API_MAX_CONTEXT=131072                           # Context window size (tokens)
API_MAX_OUTPUT=8192                              # Max output tokens per response
API_MAX_TURNS=50                                 # Max tool-calling iterations per prompt
```

## Streaming Integration

DirectApiTransport emits chunks via `onChunk(sessionKey, text)`. The pipeline's streaming system (`message-pipeline.ts`) already handles:
- Accumulate chunks in buffer
- Flush to Telegram via `editMessageText` every `STREAM_FLUSH_SEC`
- Show `▍` cursor while generating
- Final edit removes cursor

**No pipeline changes needed.** Just wire `onChunk` the same way AcpTransport does.

## Abort / Cancel

```typescript
// /stop or /ctrlc triggers:
transport.sendInterrupt(sessionKey);

// DirectApiTransport implementation:
sendInterrupt(sessionKey: string): void {
  this.abortControllers.get(sessionKey)?.abort();
}
```

The fetch request aborts immediately. Any in-progress tool execution checks the signal.

## Watchdog Integration

Current watchdog checks `transport instanceof AcpTransport`. Refactor to use a transport-agnostic interface:

```typescript
interface WatchableTransport {
  promptStartedAt: number | null;
  lastActivityAt: number | null;
  sendInterrupt(sessionKey: string): void;
}
```

Both AcpTransport and DirectApiTransport implement this. Watchdog checks the interface, not the class.

## Context Window Management

Token usage comes from the API response:
```json
{ "usage": { "prompt_tokens": 45000, "completion_tokens": 500, "total_tokens": 45500 } }
```

`contextPercent = (prompt_tokens / API_MAX_CONTEXT) * 100`

Feeds into the existing graduated threshold system (70% warn, 80% compact, 90% aggressive).

Compaction: same flow as today — send compaction prompt in the same session, extract summary, reset session, inject summary + memory context.

## Migration Path

1. **Phase 1: Basic transport** — sendPrompt, streaming, tool calling loop, execute_bash only
2. **Phase 2: Full tool registry** — all agentbridge-* CLIs as native tools
3. **Phase 3: In-process tools** — skip CLI spawn, call memory/browse directly (performance)

Phase 1 is the MVP. The agent can do everything via `execute_bash` — it just calls `agentbridge-store`, `agentbridge-recall`, etc. as bash commands. Same as today, but without kiro-cli in the middle.

Phase 2 makes tools first-class — the model sees structured function schemas instead of discovering CLIs from TOOLS.md. Better tool selection, less prompt overhead.

Phase 3 eliminates subprocess overhead — tools run in-process. This is where #66 (IPC) and the memory backend factory pay off.

## Effort Estimate

| Component | Lines | Effort |
|---|---|---|
| DirectApiTransport | ~200 | Core |
| ConversationSession | ~80 | Core |
| SSE parser | ~60 | Core |
| Tool registry (Phase 1: execute_bash only) | ~30 | Core |
| Tool registry (Phase 2: all tools) | ~100 | Follow-up |
| Watchdog refactor | ~20 | Core |
| Config additions | ~15 | Core |
| **Total Phase 1** | **~400** | **2-3 days** |

## Open Questions

1. **Token counting for non-streaming responses** — some endpoints don't return usage. Fallback: estimate from character count (÷4).
2. **Tool call format differences** — Anthropic uses `tool_use` blocks, OpenAI uses `tool_calls` array. 9Router normalizes to OpenAI format. Confirm.
3. **System prompt caching** — Anthropic has prompt caching. OpenAI doesn't. 9Router? Affects cost but not functionality.
4. **Rate limiting** — 9Router free tiers have limits. Need backoff + queue, or just let the retry utility handle it.
