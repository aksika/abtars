/**
 * anthropic-adapter.ts — Anthropic Messages API format adapter (#467).
 * Converts between our internal chat format and Anthropic's wire format.
 */

export interface AnthropicRequest {
  model: string;
  system?: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens: number;
}

export interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
}

export function toAnthropicRequest(
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  tools?: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
): AnthropicRequest & { tools?: unknown[] } {
  const system = messages.find(m => m.role === "system")?.content;
  const msgs = messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content }));
  const anthropicTools = tools?.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  return { model, ...(system ? { system } : {}), messages: msgs, max_tokens: maxTokens, ...(anthropicTools?.length ? { tools: anthropicTools } : {}) };
}

export function buildAnthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
}

export function fromAnthropicResponse(resp: AnthropicResponse): string {
  return resp.content?.find(c => c.type === "text")?.text ?? "";
}
