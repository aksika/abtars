import { logWarn } from "../logger.js";

const TAG = "model-candidates";

export type CandidateSource =
  | "primary"
  | "agent_fallback"
  | "provider_chain"
  | "inherited_chain"
  | "emergency";

export interface CandidateModel {
  model: string;
  endpoint: string;
  apiKey?: string;
  maxContext: number;
  source: CandidateSource;
}

export interface CandidateDedupResult {
  candidates: CandidateModel[];
  diagnostics: string[];
}

export function candidateKey(model: string, endpoint: string): string {
  return `${model}@${endpoint}`;
}

export function deduplicateCandidates(candidates: CandidateModel[]): CandidateDedupResult {
  const seen = new Set<string>();
  const result: CandidateModel[] = [];
  const diagnostics: string[] = [];

  for (const c of candidates) {
    const key = candidateKey(c.model, c.endpoint);
    if (seen.has(key)) {
      diagnostics.push(`Duplicate skipped: ${c.model} @ ${c.endpoint} (${c.source})`);
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

export function formatCandidateChain(candidates: CandidateModel[]): string {
  return candidates.map((c, i) => `${i + 1}. ${c.model} [${c.source}]`).join("\n");
}
