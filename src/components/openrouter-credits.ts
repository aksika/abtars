/**
 * openrouter-credits.ts — Fetch OpenRouter account credits via API.
 */
import { getEnv } from "./env-schema.js";

export interface OpenRouterCredits {
  purchased: number;
  used: number;
  remaining: number;
}

export async function fetchOpenRouterCredits(): Promise<OpenRouterCredits | null> {
  const apiKey = getEnv().getApiKey("OPENROUTER_API_KEY");
  if (!apiKey) return null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data?: { total_credits?: number; total_usage?: number } };
    const purchased = data.data?.total_credits ?? 0;
    const used = data.data?.total_usage ?? 0;
    return { purchased, used, remaining: purchased - used };
  } catch { return null; }
}
