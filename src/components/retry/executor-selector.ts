import type { ExecutorKind } from "../worker-supervision-store.js";

export interface ExecutorCandidate {
  id: string;
  kind: ExecutorKind;
  capabilities: string[];
  healthy: boolean;
  lastSeenAt?: string;
  locality?: string;
  load?: number;
}

export interface SelectionConstraints {
  requiredCapabilities: string[];
  requiredLocality?: string;
  excludedIds?: string[];
  preferredId?: string;
  enforceNoRelay?: boolean;
  sourcePeerId?: string;
}

export interface SelectionRationale {
  selectedId: string;
  selectedKind: ExecutorKind;
  eligibleCount: number;
  rejected: Array<{ id: string; reason: string }>;
  score: number;
  selectionStrategy: "preferred" | "locality" | "load" | "random";
}

export function filterCandidates(
  candidates: ExecutorCandidate[],
  constraints: SelectionConstraints,
): { eligible: ExecutorCandidate[]; rejected: Array<{ id: string; reason: string }> } {
  const rejected: Array<{ id: string; reason: string }> = [];

  const eligible = candidates.filter(c => {
    // Health
    if (!c.healthy) {
      rejected.push({ id: c.id, reason: "unhealthy" });
      return false;
    }

    // Exclusion
    if (constraints.excludedIds?.includes(c.id)) {
      rejected.push({ id: c.id, reason: "explicitly excluded" });
      return false;
    }

    // Capabilities
    const missingCaps = constraints.requiredCapabilities.filter(
      cap => !c.capabilities.includes(cap) && cap !== "*",
    );
    if (missingCaps.length > 0) {
      rejected.push({ id: c.id, reason: `missing capabilities: ${missingCaps.join(", ")}` });
      return false;
    }

    // Locality
    if (constraints.requiredLocality && c.locality !== constraints.requiredLocality) {
      rejected.push({ id: c.id, reason: `wrong locality: expected ${constraints.requiredLocality}, got ${c.locality}` });
      return false;
    }

    // No-relay
    if (constraints.enforceNoRelay && constraints.sourcePeerId && c.id === constraints.sourcePeerId) {
      rejected.push({ id: c.id, reason: "no-relay: would relay back to source peer" });
      return false;
    }

    // Kind-based: remote cannot receive peer-originated from same peer
    if (c.kind === "remote" && constraints.sourcePeerId === c.id) {
      rejected.push({ id: c.id, reason: "cannot relay to source peer" });
      return false;
    }

    return true;
  });

  return { eligible, rejected };
}

export function selectExecutor(
  candidates: ExecutorCandidate[],
  constraints: SelectionConstraints,
  previousFailedIds: string[],
): { selected: ExecutorCandidate | null; rationale: SelectionRationale } {
  const { eligible, rejected } = filterCandidates(candidates, constraints);

  if (eligible.length === 0) {
    return {
      selected: null,
      rationale: {
        selectedId: "",
        selectedKind: "agent",
        eligibleCount: 0,
        rejected,
        score: 0,
        selectionStrategy: "random",
      },
    };
  }

  // Score candidates
  const scored = eligible.map(c => {
    let score = 0;

    // Preferred executor
    if (constraints.preferredId && c.id === constraints.preferredId) {
      score += 100;
    }

    // Locality bonus
    if (constraints.requiredLocality && c.locality === constraints.requiredLocality) {
      score += 50;
    }

    // Low load bonus
    if (c.load !== undefined) {
      score += Math.max(0, 50 - c.load * 10);
    }

    // Penalize previous failures
    const failCount = previousFailedIds.filter(id => id === c.id).length;
    score -= failCount * 30;

    return { candidate: c, score: Math.max(0, score) };
  });

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.candidate.id.localeCompare(b.candidate.id);
  });

  const best = scored[0]!;

  return {
    selected: best.candidate,
    rationale: {
      selectedId: best.candidate.id,
      selectedKind: best.candidate.kind,
      eligibleCount: eligible.length,
      rejected,
      score: best.score,
      selectionStrategy: constraints.preferredId ? "preferred" : constraints.requiredLocality ? "locality" : "load",
    },
  };
}
