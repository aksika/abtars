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
  /** Candidates temporarily skipped by successful-turn rotation. */
  rotationExcludedKeys: Set<string> = new Set();
  /** Candidates excluded for a behavior incident in the current prompt. */
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
      if (this.rotationExcludedKeys.has(key)) {
        skipped.push(`${c.model}: excluded (rotation this prompt)`);
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

  /**
   * #1297: strict all-candidates credit-failure predicate. True only when the
   * candidate list is non-empty AND every member is sticky credit-failed in the
   * shared health registry — including candidates skipped during this call
   * because they were already poisoned. Mixed failure kinds, empty lists, and
   * any viable candidate all return false.
   */
  allCandidatesCreditFailed(): boolean {
    if (this.candidates.length === 0) return false;
    return this.candidates.every((c) => this.registry.isCreditFailed(c.model, c.endpoint));
  }

  recordSuccess(candidate: ModelCandidate): void {
    this.registry.recordSuccess(candidate.model, candidate.endpoint);
  }

  recordError(candidate: ModelCandidate, kind: ErrorKind, retryAfterMs?: number): void {
    this.registry.recordError(candidate.model, candidate.endpoint, kind, retryAfterMs);
  }
}
