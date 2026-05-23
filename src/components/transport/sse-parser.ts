/**
 * SSE stream parser for OpenAI-compatible chat completions.
 * Parses Server-Sent Events into typed events.
 */

export type SSEChunkEvent = { type: "chunk"; content: string };
export type SSEToolCallDelta = { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string };
export type SSEDoneEvent = { type: "done"; usage: { prompt_tokens: number; completion_tokens: number } | null };
export type SSEEvent = SSEChunkEvent | SSEToolCallDelta | SSEDoneEvent;

const STALE_TIMEOUT_MS = 90_000;

export async function* parseSSEStream(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is not readable");

  const decoder = new TextDecoder();
  let buffer = "";
  let lastChunkAt = Date.now();
  let staleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetStaleTimer = (): void => {
    lastChunkAt = Date.now();
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      if (Date.now() - lastChunkAt >= STALE_TIMEOUT_MS) {
        reader.cancel("stale stream").catch(() => {});
      }
    }, STALE_TIMEOUT_MS);
  };

  try {
    resetStaleTimer();
    while (true) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      resetStaleTimer();
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;

        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(data); } catch { continue; /* malformed SSE JSON — skip line */ }

        // Usage in final chunk (stream_options: { include_usage: true })
        if (parsed["usage"]) {
          const u = parsed["usage"] as Record<string, number>;
          yield { type: "done", usage: { prompt_tokens: u["prompt_tokens"] ?? 0, completion_tokens: u["completion_tokens"] ?? 0 } };
        }

        const choices = parsed["choices"] as Array<Record<string, unknown>> | undefined;
        if (!choices?.length) continue;
        const delta = choices[0]!["delta"] as Record<string, unknown> | undefined;
        if (!delta) continue;

        // Text content
        if (typeof delta["content"] === "string" && delta["content"]) {
          yield { type: "chunk", content: delta["content"] as string };
        }

        // Tool calls
        const toolCalls = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
        if (toolCalls) {
          for (const tc of toolCalls) {
            const fn = tc["function"] as Record<string, string> | undefined;
            yield {
              type: "tool_call_delta",
              index: (tc["index"] as number) ?? 0,
              id: tc["id"] as string | undefined,
              name: fn?.["name"],
              arguments: fn?.["arguments"],
            };
          }
        }
      }
    }
  } finally {
    if (staleTimer) clearTimeout(staleTimer);
    reader.releaseLock();
  }
}
