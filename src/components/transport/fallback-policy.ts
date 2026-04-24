/**
 * FallbackPolicy — per-agent model selection with shared health registry.
 * Owns an ordered candidate list. Delegates health checks to ModelHealthRegistry.
 */

import type { ModelHealthRegistry, ErrorKind } from "./model-health-registry.js";

export interface ModelCandidate {
  model: string;
  endpoint: string;
  apiKey?: string;
  maxContext: number;
  lastResort?: boolean;
}

export interface FallbackDecision {
  chosen: ModelCandidate;
  skipped: string[];
}

export class FallbackPolicy {
  readonly candidates: readonly ModelCandidate[];
  readonly registry: ModelHealthRegistry;
  lastDecision: FallbackDecision | null = null;

  constructor(candidates: readonly ModelCandidate[], registry: ModelHealthRegistry) {
    this.candidates = candidates;
    this.registry = registry;
  }

  /** Pick the next candidate to try. Returns null if all exhausted. */
  selectModel(sessionTokens?: number): ModelCandidate | null {
    const skipped: string[] = [];
    for (const c of this.candidates) {
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

  /** Get surviving candidates (not skipped by health). For compaction fallback. */
  survivingCandidates(): ModelCandidate[] {
    return this.candidates.filter(c => !this.registry.shouldSkip(c.model, c.endpoint));
  }

  recordSuccess(candidate: ModelCandidate): void {
    this.registry.recordSuccess(candidate.model, candidate.endpoint);
  }

  recordError(candidate: ModelCandidate, kind: ErrorKind, retryAfterMs?: number): void {
    this.registry.recordError(candidate.model, candidate.endpoint, kind, retryAfterMs);
  }
}
