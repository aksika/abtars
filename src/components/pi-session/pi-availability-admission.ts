import {
  cooldownForObservation,
  isMemoBlocked,
  memoScopeMatches,
  type MemoizableFailureKind,
  type ProviderAvailabilityEntry,
} from "./provider-availability-memo.js";

export interface PiSelectableTarget {
  authNamespace: string;
  provider: string;
  endpoint?: string;
  modelScope?: string;
}

export type PiAdmissionVerdict =
  | { admit: true; selection: PiSelectableTarget }
  | { admit: false; reason: string; retryAt: number };

export interface PiFailureObservation {
  authNamespace: string;
  provider: string;
  endpoint?: string;
  modelScope?: string;
  kind: MemoizableFailureKind;
  observedAt: number;
  retryAfterMs?: number;
}

/**
 * Admission across explicitly allowed selections: the first unblocked
 * target admits. When every allowed selection is blocked, report
 * unavailable with the earliest retry time. The memo suppresses future
 * admissions only; it never rotates an active conversation and adds no
 * provider retry loop. Credential values never appear here.
 */
export function admitPiSelection(
  selections: readonly PiSelectableTarget[],
  entries: readonly ProviderAvailabilityEntry[],
  now: number,
): PiAdmissionVerdict {
  let earliestRetry = Number.POSITIVE_INFINITY;
  for (const selection of selections) {
    const blocking = entries.find(
      (entry) => memoScopeMatches(entry, selection) && isMemoBlocked(entry, now),
    );
    if (!blocking) return { admit: true, selection };
    if (blocking.unusableUntil < earliestRetry) earliestRetry = blocking.unusableUntil;
  }
  if (selections.length === 0) {
    return { admit: false, reason: "no allowed provider selection is configured", retryAt: now };
  }
  return {
    admit: false,
    reason: `all ${selections.length} allowed provider selection(s) are cooling down`,
    retryAt: earliestRetry,
  };
}

/**
 * Record a failure observation at the Pi boundary after Pi's bounded
 * recovery has failed. Replaces any prior entry for the same scope so
 * the memo holds one observation per scope. Non-memoizable failures
 * (overflow, tool errors, policy denial, cancellation, archive/hydration
 * errors) cannot reach this function: the kind union excludes them.
 */
export function observePiFailure(
  entries: readonly ProviderAvailabilityEntry[],
  observation: PiFailureObservation,
): ProviderAvailabilityEntry[] {
  const next: ProviderAvailabilityEntry = {
    authNamespace: observation.authNamespace,
    provider: observation.provider,
    reason: observation.kind,
    observedAt: observation.observedAt,
    unusableUntil: cooldownForObservation(observation.retryAfterMs, observation.observedAt),
  };
  if (observation.endpoint !== undefined) next.endpoint = observation.endpoint;
  if (observation.modelScope !== undefined) next.modelScope = observation.modelScope;
  const rest = entries.filter((entry) => !memoScopeMatches(entry, observation));
  return [...rest, next];
}
