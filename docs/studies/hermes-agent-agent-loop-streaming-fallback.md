# Hermes Agent Architecture Study — Direct API Transport Reference

> Studied: 2026-04-06. Source: `~/workspace/hermes-agent/run_agent.py`

## Agent Loop

`run_conversation()` (line 6614) → main loop at line 6914:

```python
while api_call_count < self.max_iterations and self.iteration_budget.remaining > 0:
    # 1. Check interrupt
    # 2. Build api_messages (inject ephemeral context, reasoning)
    # 3. Call API (always streaming for health checking)
    # 4. Parse response (content + tool_calls)
    # 5. If tool_calls → _execute_tool_calls() → append results → continue
    # 6. If content only → break (done)
```

Same pattern as Claude Code but in Python. Key differences:
- Sequential by default, concurrent only for independent read-only tools
- Fallback chain: if primary model fails, switches to next provider in chain
- Iteration budget: hard limit on tool-calling rounds (default from max_iterations)
- Interrupt: `_interrupt_requested` flag checked at loop top

## Streaming (`_call_chat_completions`, line 4247)

Parses OpenAI SSE format directly:
```python
stream = client.chat.completions.create(**stream_kwargs, stream=True)
for chunk in stream:
    delta = chunk.choices[0].delta
    if delta.content:       # text chunk → fire callback
    if delta.tool_calls:    # tool call delta → accumulate
```

Key details:
- `stream_options: {"include_usage": True}` — gets token counts in final chunk
- Stale stream detection: 90s timeout if no chunks arrive
- Read timeout: 60s per chunk
- Ollama compatibility: handles reused tool_call indices (Ollama bug)
- Reasoning content: accumulates `reasoning_content` / `reasoning` fields separately

## Tool Execution (`_execute_tool_calls`, line 5794)

Dispatches to sequential or concurrent based on tool independence:
```python
if not _should_parallelize_tool_batch(tool_calls):
    return self._execute_tool_calls_sequential(...)
return self._execute_tool_calls_concurrent(...)
```

`_invoke_tool()` (line 5816) is the dispatcher — big if/elif chain mapping tool names to handlers. Some tools are inline (todo, memory, clarify), others go through a registry (`handle_function_call`).

## Fallback Chain (`_try_activate_fallback`, line 4708)

When primary model fails after retries:
1. Walk `_fallback_chain` array (configured per agent)
2. Swap client, model, provider, api_mode in-place
3. Retry loop continues with new backend
4. `_restore_primary_runtime()` resets to primary on next turn

This is elegant — the agent loop doesn't know about fallbacks. The client swap is transparent.

## What We Can Borrow

1. **Streaming with `stream_options: {"include_usage": True}`** — gets token counts without a separate API call. Essential for ctx% tracking.

2. **Stale stream detection** — if no chunks for 90s, abort and retry. Prevents silent hangs on dead connections.

3. **Fallback chain pattern** — try free model → fall back to paid. Transparent to the agent loop. Config:
   ```env
   API_FALLBACK_1_ENDPOINT=https://openrouter.ai/api/v1
   API_FALLBACK_1_KEY=sk-or-...
   API_FALLBACK_1_MODEL=anthropic/claude-sonnet-4
   ```

4. **Iteration budget** — hard limit on tool-calling rounds per prompt. Prevents infinite loops. We'd use `API_MAX_TURNS=50`.

5. **Interrupt at loop top** — check abort signal before each API call, not just during streaming. Clean exit point.

6. **Ollama tool_call index fix** — Ollama reuses index 0 for all tool calls in a batch. Hermes tracks by ID, not index. We should do the same.

## What We Don't Need

- Concurrent tool execution (our tools are bash-based, sequential)
- Fallback chain (Phase 1 — add later)
- Reasoning content handling (model-specific, not needed for OpenAI format)
- Codex/Anthropic api_mode switching (we target OpenAI format only)
- KawaiiSpinner (😄)

## Key Numbers from Hermes

- Default max_iterations: configurable per agent, typically 20-50
- API timeout: 1800s (30 min!)
- Stream read timeout: 60s per chunk
- Stale stream detection: 90s
- Max retries: 3 per API call
- Tool call deduplication: yes (same function+args = skip duplicate)
