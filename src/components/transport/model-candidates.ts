/**
 * model-candidates.ts — Canonical candidate model + shared construction.
 *
 * #1418: One `ModelCandidate` type for the whole bridge. Every candidate
 * carries its full identity tuple (model, provider, endpoint, apiKey,
 * maxContext) so provider switching and success tracking preserve the
 * complete candidate, and specialist fallback can reuse the exact Main
 * candidate that last produced a non-empty response.
 *
 * `candidateKey()` (model@endpoint) remains the health-registry identity.
 * Deduplication of the candidate *list* uses the richer `candidateIdentityKey()`
 * (provider/model@endpoint) so the same model on two providers is a distinct
 * candidate, while a true duplicate triple collapses.
 */
import { logWarn } from "../logger.js";

const TAG = "model-candidates";

export type CandidateSource =
  | "primary"
  | "agent_fallback"
  | "provider_chain"
  | "inherited_chain"
  | "emergency";

/** Secret-free identity + context needed to rebuild a candidate. */
export interface CandidateSpec {
  model: string;
  provider: string;
  endpoint: string;
  maxContext: number;
}

/** Full canonical candidate — provider identity is required (#1418). */
export interface ModelCandidate extends CandidateSpec {
  apiKey?: string;
  source: CandidateSource;
}

export interface CandidateDedupResult {
  candidates: ModelCandidate[];
  diagnostics: string[];
}

/** Health-registry identity: model + endpoint (provider-agnostic). */
export function candidateKey(model: string, endpoint: string): string {
  return `${model}@${endpoint}`;
}

/** Candidate-list identity: provider + model + endpoint (#1418). */
export function candidateIdentityKey(c: { model: string; provider: string; endpoint: string }): string {
  return `${c.provider}/${c.model}@${c.endpoint}`;
}

export function deduplicateCandidates(candidates: ModelCandidate[]): CandidateDedupResult {
  const seen = new Set<string>();
  const result: ModelCandidate[] = [];
  const diagnostics: string[] = [];

  for (const c of candidates) {
    const key = candidateIdentityKey(c);
    if (seen.has(key)) {
      diagnostics.push(`Duplicate skipped: ${c.model} @ ${c.endpoint} via ${c.provider} (${c.source})`);
      continue;
    }
    seen.add(key);
    result.push(c);
  }

  if (diagnostics.length > 0) {
    for (const d of diagnostics) logWarn(TAG, d);
  }

  return { candidates: result, diagnostics };
}

export function formatCandidateChain(candidates: ModelCandidate[]): string {
  return candidates
    .map((c, i) => `${i + 1}. ${c.model} via ${c.provider} [${c.source}]`)
    .join("\n");
}

/**
 * Build the ordered, deduplicated candidate list for one role.
 *
 * - Main: configured Main → top-level fallback chain.
 * - Specialist: configured role → last successful Main (or configured Main
 *   when none has succeeded yet) → top-level fallback chain.
 *
 * Inputs are pre-resolved into complete candidates (provider/endpoint/apiKey/
 * maxContext). Deduplication by provider/model/endpoint preserves first
 * occurrence and configured order. Provider/agent legacy fallback lists are
 * never appended here — only the top-level chain. hailMary is never appended.
 */
export function buildCandidates(args: {
  role: "main" | "specialist";
  configured: ModelCandidate;
  lastSuccessfulMain?: ModelCandidate | null;
  fallbacks?: ModelCandidate[];
}): ModelCandidate[] {
  const ordered: ModelCandidate[] = [{ ...args.configured, source: "primary" }];

  if (args.role === "specialist" && args.lastSuccessfulMain) {
    ordered.push({ ...args.lastSuccessfulMain, source: "inherited_chain" });
  }

  for (const fb of args.fallbacks ?? []) {
    ordered.push({ ...fb, source: "agent_fallback" });
  }

  return deduplicateCandidates(ordered).candidates;
}
