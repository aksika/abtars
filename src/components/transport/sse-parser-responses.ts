/**
 * sse-parser-responses.ts — OpenAI Responses API streaming parser (#472).
 * Yields same SSEEvent types as sse-parser.ts for consumer compatibility.
 * v1: text streaming only.
 */

import type { SSEEvent } from "./sse-parser.js";
import { logAndSwallow } from "../log-and-swallow.js";

const TAG = "sse_parser_responses";

export async function* parseResponsesSSE(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is not readable");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let eventType = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ") && eventType) {
          const data = line.slice(6).trim();
          let parsed: Record<string, unknown>;
          try { parsed = JSON.parse(data); } catch (err) { logAndSwallow(TAG, "JSON.parse SSE chunk", err); eventType = ""; continue; }

          if (eventType === "response.output_text.delta") {
            const delta = parsed["delta"] as string | undefined;
            if (delta) yield { type: "chunk", content: delta };
          } else if (eventType === "response.function_call_arguments.delta") {
            yield { type: "tool_call_delta", index: 0, id: (parsed["call_id"] as string) ?? undefined, name: undefined, arguments: (parsed["delta"] as string) ?? "" };
          } else if (eventType === "response.function_call_arguments.done") {
            yield { type: "tool_call_delta", index: 0, id: (parsed["call_id"] as string) ?? undefined, name: (parsed["name"] as string) ?? undefined, arguments: undefined };
          } else if (eventType === "response.completed" || eventType === "response.done") {
            yield { type: "done", usage: null };
            return;
          }
          eventType = "";
        }
      }
    }
    yield { type: "done", usage: null };
  } finally {
    reader.releaseLock();
  }
}
