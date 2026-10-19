/**
 * model-candidates.ts — Canonical candidate model.
 *
 * #1418: One `ModelCandidate` type for the whole bridge. Every candidate
 * carries its full identity tuple (model, provider, endpoint, apiKey,
 * maxContext).
 *
 * #1932: exactly one candidate serves a Pi transport — no fallback chains,
 * no Main inheritance, no rotation. `candidateKey()` (model@endpoint) remains
 * the telemetry/attribution identity.
 */
import type { ApiFormat, PiAiCandidate } from "./pi-ai-adapter.js";

export type CandidateSource = "primary";

/** Secret-free identity + context needed to rebuild a candidate. */
export interface CandidateSpec {
  model: string;
  provider: string;
  endpoint: string;
  maxContext: number;
  apiFormat?: ApiFormat;
  /** #1757: Pi-managed auth mode carried per candidate so fallback rotation
   *  can never inherit or borrow another candidate's credential path. A
   *  Pi-managed candidate carries no apiKey; dispatch resolves auth from Pi's
   *  configured runtime at request time. */
  authSource?: "pi";
  thinking?: PiAiCandidate["thinking"];
  /** #1770: resolved max output tokens (pi catalog wins, models.json floor).
   *  Threaded from ResolvedAgent at construction; resolveCandidateModel falls
   *  back to a live pi-catalog lookup when absent. Optional so ad-hoc and
   *  test fixtures without resolved metadata keep compiling. */
  maxOutput?: number;
  /** #1748: provider-resolved prompt-cache retention for this candidate.
   *  Keeping it on the candidate prevents a fallback provider from inheriting
   *  the primary provider's retention policy. */
  cacheRetention?: "none" | "short" | "long";
}

/** Full canonical candidate — provider identity is required (#1418). */
export interface ModelCandidate extends CandidateSpec {
  apiKey?: string;
  source: CandidateSource;
}

/** Health-registry identity: model + endpoint (provider-agnostic). */
export function candidateKey(model: string, endpoint: string): string {
  return `${model}@${endpoint}`;
}

/**
 * #1757: resolve the auth slice for one candidate from its provider entry.
 * Pi-managed providers (`authSource: "pi"`) resolve no key here — dispatch
 * owns auth at request time — and never inherit another candidate's key.
 * Keyed providers resolve their own `apiKeyEnv`; providers with neither fall
 * back to the inherited key (historical ollama-style behavior, unchanged).
 */
export function resolveCandidateAuth(
  provider: { apiKeyEnv?: string; authSource?: string },
  getApiKey: (envName: string) => string | undefined,
  inheritKey?: string,
): { apiKey?: string; authSource?: "pi" } {
  if (provider.authSource === "pi") return { apiKey: undefined, authSource: "pi" };
  if (provider.apiKeyEnv) return { apiKey: getApiKey(provider.apiKeyEnv) };
  return { apiKey: inheritKey };
}
