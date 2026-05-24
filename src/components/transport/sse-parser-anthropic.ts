/**
 * sse-parser-anthropic.ts — Anthropic Messages API streaming parser (#472).
 * Yields same SSEEvent types as sse-parser.ts for consumer compatibility.
 * v1: text streaming only. Tool calls (tool_use blocks) not yet mapped.
 */

import type { SSEEvent } from "./sse-parser.js";
import { logAndSwallow } from "../log-and-swallow.js";

const TAG = "sse_parser_anthropic";

export async function* parseAnthropicSSE(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is not readable");

  const decoder = new TextDecoder();
  let buffer = "";
  let usage: { prompt_tokens: number; completion_tokens: number } | null = null;

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

          if (eventType === "content_block_delta") {
            const delta = parsed["delta"] as Record<string, unknown> | undefined;
            if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
              yield { type: "chunk", content: delta["text"] as string };
            } else if (delta?.["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
              yield { type: "tool_call_delta", index: (parsed["index"] as number) ?? 0, id: undefined, name: undefined, arguments: delta["partial_json"] as string };
            }
          } else if (eventType === "content_block_start") {
            const block = parsed["content_block"] as Record<string, unknown> | undefined;
            if (block?.["type"] === "tool_use") {
              yield { type: "tool_call_delta", index: (parsed["index"] as number) ?? 0, id: block["id"] as string, name: block["name"] as string, arguments: undefined };
            }
          } else if (eventType === "message_delta") {
            const u = parsed["usage"] as Record<string, number> | undefined;
            if (u) usage = { prompt_tokens: u["input_tokens"] ?? 0, completion_tokens: u["output_tokens"] ?? 0 };
          } else if (eventType === "message_stop") {
            yield { type: "done", usage };
            return;
          }
          eventType = "";
        }
      }
    }
    yield { type: "done", usage };
  } finally {
    reader.releaseLock();
  }
}
