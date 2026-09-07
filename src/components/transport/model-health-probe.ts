/**
 * OpenRouter rejects chat probes with fewer than 16 requested output tokens.
 * Keep the payload shared by the scheduled and manual model health checks so
 * they cannot drift into provider-incompatible requests.
 */
export const MODEL_HEALTH_PROBE_MAX_TOKENS = 16;

export function modelHealthProbeBody(model: string): {
  model: string;
  messages: [{ role: "user"; content: string }];
  max_tokens: number;
} {
  return {
    model,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: MODEL_HEALTH_PROBE_MAX_TOKENS,
  };
}
