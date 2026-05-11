/**
 * responses-adapter.ts — OpenAI Responses API format adapter (#465).
 * Converts between our internal chat format and the Responses API wire format.
 */

export interface ResponsesRequest {
  model: string;
  input: string;
  instructions?: string;
  tools?: unknown[];
  max_output_tokens?: number;
}

export interface ResponsesResponse {
  id: string;
  output: Array<{ type: string; content?: Array<{ type: string; text?: string }>; name?: string; arguments?: string }>;
}

/** Convert chat/completions-style messages to Responses API request. */
export function toResponsesRequest(
  model: string,
  messages: Array<{ role: string; content: string }>,
  tools?: unknown[],
  maxTokens?: number,
): ResponsesRequest {
  // System message → instructions, rest → concatenated input
  const system = messages.find(m => m.role === "system");
  const userMessages = messages.filter(m => m.role !== "system");
  const input = userMessages.map(m => m.content).join("\n\n");

  return {
    model,
    input,
    ...(system ? { instructions: system.content } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
  };
}

/** Extract text content from Responses API response. */
export function fromResponsesResponse(resp: ResponsesResponse): string {
  for (const item of resp.output) {
    if (item.type === "message" && item.content) {
      const text = item.content.find(c => c.type === "text");
      if (text?.text) return text.text;
    }
  }
  return "";
}
