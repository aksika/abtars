import type { ModelHealthRegistry, ErrorKind } from "./model-health-registry.js";
import { candidateKey } from "./model-candidates.js";
import type { ModelCandidate } from "./model-candidates.js";

// #1418: `ModelCandidate` is now defined once in model-candidates.ts and carries
// the complete identity tuple (including provider). Re-export so existing
// `import { ModelCandidate } from "./fallback-policy.js"` keeps working.
export type { ModelCandidate } from "./model-candidates.js";
export type { CandidateSpec } from "./model-candidates.js";

export interface FallbackDecision {
  chosen: ModelCandidate;
  skipped: string[];
}

export class FallbackPolicy {
  readonly candidates: readonly ModelCandidate[];
  readonly registry: ModelHealthRegistry;
  lastDecision: FallbackDecision | null = null;
  excludedKeys: Set<string> = new Set();

  constructor(candidates: readonly ModelCandidate[], registry: ModelHealthRegistry) {
    this.candidates = candidates;
    this.registry = registry;
  }

  /** Pick the next candidate to try. Returns null if all exhausted. */
  selectModel(sessionTokens?: number): ModelCandidate | null {
    const skipped: string[] = [];
    for (const c of this.candidates) {
      const key = candidateKey(c.model, c.endpoint);
      if (this.excludedKeys.has(key)) {
        skipped.push(`${c.model}: excluded (behavior failure this prompt)`);
        continue;
      }
      if (this.registry.shouldSkip(c.model, c.endpoint)) {
        const level = this.registry.getBucketLevel(c.model, c.endpoint);
        skipped.push(`${c.model}: bucket ${level}%`);
        continue;
      }
      if (sessionTokens && sessionTokens > 0 && c.maxContext > 0 && sessionTokens > c.maxContext * 0.95) {
        skipped.push(`${c.model}: context too large`);
        continue;
      }
      this.lastDecision = { chosen: c, skipped };
      return c;
    }
    this.lastDecision = null;
    return null;
  }

  /** Get surviving candidates (not skipped by health or exclusion). For compaction fallback. */
  survivingCandidates(): ModelCandidate[] {
    return this.candidates.filter(c => {
      const key = candidateKey(c.model, c.endpoint);
      if (this.excludedKeys.has(key)) return false;
      return !this.registry.shouldSkip(c.model, c.endpoint);
    });
  }

  recordSuccess(candidate: ModelCandidate): void {
    this.registry.recordSuccess(candidate.model, candidate.endpoint);
  }

  recordError(candidate: ModelCandidate, kind: ErrorKind, retryAfterMs?: number): void {
    this.registry.recordError(candidate.model, candidate.endpoint, kind, retryAfterMs);
  }
}
