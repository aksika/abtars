/**
 * stream-single.ts — Single-shot LLM completion for internal use (summarization, etc.).
 * Non-streaming, returns full text response.
 */

export interface SingleCompletionParams {
  endpoint: string;
  apiKey?: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
}

export async function streamSingleCompletion(params: SingleCompletionParams): Promise<string> {
  const { endpoint, apiKey, model, systemPrompt, userPrompt, maxTokens } = params;

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxTokens,
    stream: false,
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`Summarization LLM call failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}
