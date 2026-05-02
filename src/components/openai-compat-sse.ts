/**
 * openai-compat-sse — Server-Sent Events formatter for streaming chat completions (#373).
 *
 * v1 is "buffered streaming": await the full agent reply, emit as a single
 * delta chunk, then `data: [DONE]`. True token-by-token streaming deferred
 * until kiro-cli supports partial-output forwarding.
 *
 * Pure functions. Unit-tested in isolation.
 */

import { randomUUID } from "node:crypto";

export interface SSEChunkOpts {
  /** The chatcmpl id — should match across all chunks of one stream. */
  id?: string;
  model: string;
  /** Epoch seconds. Optional; auto-generated if omitted. */
  created?: number;
}

export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: { role?: "assistant"; content?: string };
    finish_reason: null | "stop" | "length" | "tool_calls";
  }>;
}

/** Format a delta chunk with content. */
export function deltaChunk(content: string, opts: SSEChunkOpts): string {
  const chunk: OpenAIStreamChunk = {
    id: opts.id ?? `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: opts.created ?? Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  };
  return formatSSE(chunk);
}

/** Format the final chunk with finish_reason set and no delta content. */
export function finishChunk(opts: SSEChunkOpts & { reason?: "stop" | "length" }): string {
  const chunk: OpenAIStreamChunk = {
    id: opts.id ?? `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: opts.created ?? Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [{ index: 0, delta: {}, finish_reason: opts.reason ?? "stop" }],
  };
  return formatSSE(chunk);
}

/** Terminator — OpenAI SDK clients wait for this to close the stream. */
export const DONE_MARKER = "data: [DONE]\n\n";

/**
 * Emit an error mid-stream (after headers are already sent, full-response
 * error envelope is no longer possible). Clients see this and close.
 * Followed by DONE_MARKER.
 */
export function streamError(message: string, code?: string): string {
  const payload = { error: { message, type: "server_error", ...(code ? { code } : {}) } };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Format a single SSE frame. Each data line must be followed by a blank line.
 */
function formatSSE(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Compose the full buffered-streaming sequence for a complete reply.
 * Returns the concatenated string that can be written to the response in
 * one go (or with a small delay between chunks if true streaming is faked).
 *
 * Sequence: delta(full content) → finish → [DONE]
 */
export function bufferedStreamBody(content: string, opts: SSEChunkOpts & { reason?: "stop" | "length" }): string {
  const id = opts.id ?? `chatcmpl-${randomUUID()}`;
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const common: SSEChunkOpts = { id, model: opts.model, created };
  return (
    deltaChunk(content, common) +
    finishChunk({ ...common, ...(opts.reason ? { reason: opts.reason } : {}) }) +
    DONE_MARKER
  );
}
