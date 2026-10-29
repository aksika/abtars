/**
 * Pure reconciliation decision tests (#1711 R6, Phase 2). The classifier must
 * stay free of filesystem/process/timer/signal/logging side effects — these
 * tests pin the closed outcome set and the safety invariants.
 */
import { describe, it, expect } from "vitest";
import {
  decideReconciliation,
  isLivenessContainmentEligible,
  type ReconcileInput,
  type LockObservation,
  type BridgeProcessRecord,
  type ExtraCandidate,
} from "./reconcile.js";

const NOW = 1_800_000_000_000;
const STALE_MS = 300_000;

function ownerLock(overrides: Partial<Extract<LockObservation, { kind: "snapshot" }>["lock"]> = {}): LockObservation {
  return {
    kind: "snapshot",
    lock: {
      pid: 100,
      startIdentity: "100:5000",
      validatedOwner: true,
      lastHeartbeat: NOW - 5_000,
      ...overrides,
    },
  };
}

function corruptLock(lastHeartbeat: number | null = null): LockObservation {
  return { kind: "snapshot", lock: { pid: 100, startIdentity: "100:5000", validatedOwner: false, lastHeartbeat } };
}

function proc(pid: number, startIdentity: string, exactTarget = true): BridgeProcessRecord {
  return { pid, startIdentity, exactTarget };
}

function baseInput(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    now: NOW,
    lock: ownerLock(),
    processes: [proc(100, "100:5000")],
    transition: "stable",
    candidates: [],
    ownershipEpisode: null,
    livenessEvidence: null,
    ...overrides,
  };
}

describe("closed classification truth table (#1711 R6)", () => {
  it("validated owner + exactly that process -> clean", () => {
    expect(decideReconciliation(baseInput())).toEqual({ kind: "clean" });
  });

  it("validated owner + exact others -> candidate nomination with owner authority", () => {
    const d = decideReconciliation(baseInput({ processes: [proc(100, "100:5000"), proc(200, "200:6000")] }));
    expect(d).toMatchObject({ kind: "extra-candidate", authority: "owner", candidate: { pid: 200, observations: 1 } });
  });

  it("exact processes without a validated owner -> ownership-inconclusive", () => {
    const d = decideReconciliation(baseInput({ lock: { kind: "corrupt" }, processes: [proc(300, "300:7000")] }));
    expect(d).toEqual({ kind: "ownership-inconclusive", reason: "no-validated-owner-lock-corrupt" });
  });

  it("complete empty enumeration -> none (the only spawn authorization)", () => {
    expect(decideReconciliation(baseInput({ processes: [] }))).toEqual({ kind: "none" });
  });

  it("failed snapshot -> enumeration-failed regardless of lock", () => {
    expect(decideReconciliation(baseInput({ processes: "enumeration-failed" }))).toEqual({ kind: "enumeration-failed" });
  });

  it("any active transition fence dominates every other input", () => {
    for (const transition of ["planned-restart", "update", "rollback", "stop", "handoff"] as const) {
      const d = decideReconciliation(baseInput({
        transition,
        processes: [proc(100, "100:5000"), proc(200, "200:6000")],
      }));
      expect(d).toEqual({ kind: "planned-transition" });
    }
  });

  it("validated owner absent from the enumerated set -> owner-missing hold", () => {
    const d = decideReconciliation(baseInput({ processes: [proc(999, "999:1111")] }));
    expect(d).toEqual({ kind: "owner-missing" });
  });
});

describe("candidate advancement and reset (#1711 R6)", () => {
  it("advances observations on consecutive identical nominations", () => {
    const prior: ExtraCandidate[] = [{ pid: 200, startIdentity: "200:6000", observations: 2 }];
    const d = decideReconciliation(baseInput({
      processes: [proc(100, "100:5000"), proc(200, "200:6000")],
      candidates: prior,
    }));
    // Third consecutive observation reaches containment readiness.
    expect(d).toMatchObject({ kind: "contain-extra", authority: "owner", candidate: { observations: 3 } });
  });

  it("restarts counting when identity changes (PID reuse breaks candidacy)", () => {
    const prior: ExtraCandidate[] = [{ pid: 200, startIdentity: "200:OLD", observations: 2 }];
    const d = decideReconciliation(baseInput({
      processes: [proc(100, "100:5000"), proc(200, "200:NEW")],
      candidates: prior,
    }));
    expect(d).toMatchObject({ kind: "extra-candidate", candidate: { observations: 1 } });
  });
});

describe("owner protection invariants", () => {
  it("never nominates the validated owner as a target", () => {
    const d = decideReconciliation(baseInput({
      processes: [proc(100, "100:5000"), proc(200, "200:6000")],
      candidates: [{ pid: 100, startIdentity: "100:5000", observations: 2 }],
    }));
    expect(d).toMatchObject({ kind: "extra-candidate", candidate: { pid: 200 } });
  });

  it("a validated owner forces owner authority even when liveness evidence would also qualify", () => {
    // Liveness authority applies ONLY when no validated owner exists.
    const d = decideReconciliation(baseInput({
      processes: [proc(100, "100:5000"), proc(200, "200:6000")],
      livenessEvidence: { nowMs: NOW, staleMs: STALE_MS, heartbeatAdvanced: false },
      lock: ownerLock({ lastHeartbeat: NOW - 700_000 }),
    }));
    expect(d).toMatchObject({ kind: "extra-candidate", authority: "owner", candidate: { pid: 200 } });
  });
});

describe("R5 narrow liveness escape (#1711 R5)", () => {
  function frozenInput(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
    return baseInput({
      lock: corruptLock(NOW - 700_000), // readable heartbeat, 700s old (> 2x300s)
      processes: [proc(300, "300:7000")],
      livenessEvidence: { nowMs: NOW, staleMs: STALE_MS, heartbeatAdvanced: false },
      ...overrides,
    });
  }

  it("is eligible when all five conditions hold and becomes contain-extra at three observations", () => {
    const step1 = decideReconciliation(frozenInput());
    expect(step1).toMatchObject({ kind: "extra-candidate", authority: "liveness", candidate: { observations: 1 } });
    const c1 = (step1 as { candidate: ExtraCandidate }).candidate;
    const step2 = decideReconciliation(frozenInput({ candidates: [c1] }));
    expect(step2).toMatchObject({ kind: "extra-candidate", candidate: { observations: 2 } });
    const c2 = (step2 as { candidate: ExtraCandidate }).candidate;
    // Candidate state carries the CURRENT observation only.
    const step3 = decideReconciliation(frozenInput({ candidates: [c2] }));
    expect(step3).toMatchObject({ kind: "contain-extra", authority: "liveness", candidate: { pid: 300, observations: 3 } });
  });

  it("stays ineligible while the heartbeat is advancing", () => {
    const d = decideReconciliation(frozenInput({
      livenessEvidence: { nowMs: NOW, staleMs: STALE_MS, heartbeatAdvanced: true },
    }));
    expect(d).toEqual({ kind: "ownership-inconclusive", reason: "no-validated-owner-heartbeat-advancing" });
  });

  it("stays ineligible before 2xSTALE age", () => {
    const d = decideReconciliation(frozenInput({ lock: corruptLock(NOW - 100_000) }));
    expect(d).toEqual({ kind: "ownership-inconclusive", reason: "no-validated-owner" });
  });

  it("stays ineligible when the heartbeat is unreadable", () => {
    const d = decideReconciliation(frozenInput({ lock: corruptLock(null) }));
    expect(d).toEqual({ kind: "ownership-inconclusive", reason: "no-validated-owner-heartbeat-unreadable" });
  });

  it("stays ineligible without an observation window (fresh watchdog restore)", () => {
    const d = decideReconciliation(frozenInput({ livenessEvidence: null }));
    expect(d).toEqual({ kind: "ownership-inconclusive", reason: "no-validated-owner" });
  });

  it("predicate rejects boundary age exactly at 2xSTALE", () => {
    expect(isLivenessContainmentEligible(
      { pid: 300, startIdentity: "300:7000", validatedOwner: false, lastHeartbeat: NOW - 600_000 },
      { nowMs: NOW, staleMs: STALE_MS, heartbeatAdvanced: false },
    )).toBe(false);
  });
});
