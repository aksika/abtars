/**
 * Typed reconciliation boundary — PURE decision logic (#1711 R6, Phase 2).
 *
 * No filesystem, process, timer, signal, or logging side effects may live in
 * this module. The impure executor (state-cli commands, containment) consumes
 * these decisions; the shell never classifies processes or chooses targets.
 */
import type { OwnershipEpisode } from "./state.js";

/** Snapshot of bridge.lock relevant to reconciliation. */
export interface LockSnapshot {
  readonly pid: number;
  readonly startIdentity: string;
  /** True only when the full lock validator accepted pid+instanceId+startIdentity+argv. */
  readonly validatedOwner: boolean;
  /** Readable numeric lastHeartbeat, or null when absent/unparseable. */
  readonly lastHeartbeat: number | null;
}

export type LockObservation =
  | { readonly kind: "snapshot"; readonly lock: LockSnapshot }
  | { readonly kind: "missing" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "unreadable" };

export type TransitionState =
  | "stable"
  | "planned-restart"
  | "update"
  | "rollback"
  | "stop"
  | "handoff";

/**
 * Evidence for the narrow R5 liveness escape, computed by the caller from its
 * in-memory observation window. Null when the watchdog has no usable window
 * (e.g. right after restore).
 */
export interface LivenessEvidence {
  readonly nowMs: number;
  /** Production staleness threshold in ms (STALE); eligibility requires age > 2x. */
  readonly staleMs: number;
  /** Did lastHeartbeat advance AT ANY POINT during the observation window? */
  readonly heartbeatAdvanced: boolean;
}

/** In-memory, per-watchdog-lifetime candidate observation. Never persisted. */
export interface ExtraCandidate {
  readonly pid: number;
  readonly startIdentity: string;
  readonly observations: number;
}

export interface ReconcileInput {
  readonly now: number;
  readonly lock: LockObservation;
  readonly processes: readonly BridgeProcessRecord[] | "enumeration-failed";
  readonly transition: TransitionState;
  readonly candidates: readonly ExtraCandidate[];
  readonly ownershipEpisode: OwnershipEpisode | null;
  readonly livenessEvidence: LivenessEvidence | null;
}

/** Minimal process record the classifier needs (from supervisor/identity). */
export interface BridgeProcessRecord {
  readonly pid: number;
  readonly startIdentity: string;
  readonly exactTarget: boolean;
}

export type ContainmentAuthority = "owner" | "liveness";

export type ReconcileDecision =
  | { readonly kind: "clean" }
  | { readonly kind: "none" }
  | { readonly kind: "owner-missing" }
  | { readonly kind: "ownership-inconclusive"; readonly reason: string }
  | { readonly kind: "enumeration-failed" }
  | { readonly kind: "planned-transition" }
  | { readonly kind: "extra-candidate"; readonly candidate: ExtraCandidate; readonly authority: ContainmentAuthority }
  | { readonly kind: "contain-extra"; readonly candidate: ExtraCandidate; readonly authority: ContainmentAuthority };

const CONTAINMENT_OBSERVATIONS_REQUIRED = 3;

/**
 * Narrow R5 liveness escape (#1711 R5). ALL conditions must hold; anything
 * missing stays fail-closed:
 * 1. successful enumeration with >=1 exact process (checked by caller of this predicate);
 * 2. no validated lock owner (checked before calling);
 * 3. lock provides a readable numeric lastHeartbeat;
 * 4. the value did not advance anywhere in the observation window;
 * 5. age > 2 x STALE.
 */
export function isLivenessContainmentEligible(
  lock: LockSnapshot,
  evidence: LivenessEvidence | null,
): boolean {
  if (evidence === null) return false;
  if (lock.lastHeartbeat === null || !Number.isFinite(lock.lastHeartbeat)) return false;
  if (evidence.heartbeatAdvanced) return false;
  return evidence.nowMs - lock.lastHeartbeat > 2 * evidence.staleMs;
}

function findPrior(
  candidates: readonly ExtraCandidate[],
  pid: number,
  startIdentity: string,
): ExtraCandidate | undefined {
  return candidates.find((c) => c.pid === pid && c.startIdentity === startIdentity);
}

function advanceCandidate(
  candidates: readonly ExtraCandidate[],
  pid: number,
  startIdentity: string,
  authority: ContainmentAuthority,
): ReconcileDecision {
  const prior = findPrior(candidates, pid, startIdentity);
  const candidate: ExtraCandidate = {
    pid,
    startIdentity,
    observations: (prior?.observations ?? 0) + 1,
  };
  if (candidate.observations >= CONTAINMENT_OBSERVATIONS_REQUIRED) {
    return { kind: "contain-extra", candidate, authority };
  }
  return { kind: "extra-candidate", candidate, authority };
}

/**
 * Classify one tick's combined snapshot into a closed decision set.
 *
 * Only `none` authorizes the existing spawn path. `owner-missing`,
 * `ownership-inconclusive`, and `enumeration-failed` never spawn. A signal
 * candidate requires three consecutive qualifying observations on unchanged
 * PID + start identity, a complete snapshot, no active transition fence, and
 * either a different validated owner or the complete R5 liveness condition.
 */
export function decideReconciliation(input: ReconcileInput): ReconcileDecision {
  // Planned-transition protection (R7): observation-only until the fence
  // clears. Fence observations do not advance candidates toward containment.
  if (input.transition !== "stable") {
    return { kind: "planned-transition" };
  }
  if (input.processes === "enumeration-failed") {
    return { kind: "enumeration-failed" };
  }

  const exact = input.processes.filter((p) => p.exactTarget);

  // Complete enumeration with zero exact processes: the ONLY spawn authorization.
  if (exact.length === 0) {
    return { kind: "none" };
  }

  const lock = input.lock;

  // Validated-owner paths.
  if (lock.kind === "snapshot" && lock.lock.validatedOwner) {
    const owner = lock.lock;
    const ownerPresent = exact.some(
      (p) => p.pid === owner.pid && p.startIdentity === owner.startIdentity,
    );
    if (!ownerPresent) {
      // Enumeration contradicts the validated lock: hold without acting.
      return { kind: "owner-missing" };
    }
    const extras = exact.filter((p) => !(p.pid === owner.pid && p.startIdentity === owner.startIdentity));
    if (extras.length === 0) {
      return { kind: "clean" };
    }
    // Owner protection (invariant 5): the validated owner is never a target.
    // Nominate ONE extra at a time (stable order by pid) — the executor
    // re-enumerates after each containment result.
    const nominee = [...extras].sort((a, b) => a.pid - b.pid)[0]!;
    return advanceCandidate(input.candidates, nominee.pid, nominee.startIdentity, "owner");
  }

  // Exact processes exist but no validated owner: fail-closed hold, with the
  // narrow R5 liveness exception evaluated separately.
  if (lock.kind === "snapshot") {
    if (isLivenessContainmentEligible(lock.lock, input.livenessEvidence)) {
      const nominee = [...exact].sort((a, b) => a.pid - b.pid)[0]!;
      return advanceCandidate(input.candidates, nominee.pid, nominee.startIdentity, "liveness");
    }
    const reason = lock.lock.lastHeartbeat === null
      ? "no-validated-owner-heartbeat-unreadable"
      : input.livenessEvidence?.heartbeatAdvanced
        ? "no-validated-owner-heartbeat-advancing"
        : "no-validated-owner";
    return { kind: "ownership-inconclusive", reason };
  }

  return {
    kind: "ownership-inconclusive",
    reason: `no-validated-owner-lock-${lock.kind}`,
  };
}
