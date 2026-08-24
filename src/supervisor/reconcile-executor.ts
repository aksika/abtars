/**
 * Narrow reconciliation executor (#1711 R6/R7, Phase 2) — the ONLY impure
 * counterpart of the pure classifier. It can persist/clear the ownership
 * episode marker and contain a fully authorized candidate. It never spawns,
 * never records ordinary bridge death, never calculates backoff, and never
 * broadens a signal to a process group.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateBridgeLock,
  enumerateBridgeProcesses,
  isPidAlive,
  potentialHomeBridgeProcesses,
  type UnattributableProcess,
} from "./identity.js";
import {
  decideReconciliation,
  isLivenessContainmentEligible,
  type LockObservation,
  type LockSnapshot,
  type TransitionState,
  type BridgeProcessRecord,
  type ContainmentAuthority,
  type LivenessEvidence,
} from "./reconcile.js";
import { readSupervisorState, setOwnershipEpisode, clearOwnershipEpisode } from "./state.js";

/** Must mirror STALE in scripts/abtars-watchdog.sh (production 300s). */
export const PRODUCTION_STALE_MS = 300_000;

/** Grace window between SIGTERM and the reauthorized SIGKILL (#1711 R6). */
const ESCALATION_GRACE_MS = 3_000;

const LOCK_VALIDATOR_NEEDLES = ["abtars.js", "bundle"];

/**
 * Freshly validate bridge.lock and report the CURRENT owner's identity
 * (#1711 R3). Used by the planned-command path at the SAME authorization
 * point as its termination: only a fully valid lock yields a usable
 * PID/start-identity pair; anything else yields null (no exclusion exists).
 */
export function readValidatedOwner(home: string): { readonly pid: number; readonly startIdentity: string } | null {
  const lock = buildLockObservation(home);
  if (lock.kind !== "snapshot" || !lock.lock.validatedOwner) return null;
  if (!Number.isInteger(lock.lock.pid) || lock.lock.pid <= 0) return null;
  if (!lock.lock.startIdentity) return null;
  return { pid: lock.lock.pid, startIdentity: lock.lock.startIdentity };
}

export type SpawnProof =
  | { readonly result: "empty"; readonly unattributable: readonly UnattributableProcess[] }
  | { readonly result: "occupied"; readonly count: number; readonly unattributable: readonly UnattributableProcess[] }
  | { readonly result: "inconclusive"; readonly unattributable: readonly UnattributableProcess[] };

/**
 * Zero-process proof before spawn (#1711 R3). Blocking set is the BROADER
 * could-be-same-home predicate: any spelling inside this home, or a relative
 * spelling whose home cannot be attributed — fail-closed per R2 ("never spawn
 * beside it"), while containment stays strictly exactTarget.
 *
 * `exclude` implements the ONE planned-replacement exception: during a
 * restart/update/rollback fence, exactly the recorded terminated owner's
 * PID/start identity may be disregarded. Every other process — exact,
 * identity-inconclusive, or unknown — and any incomplete snapshot still
 * vetoes. Stop and handoff never pass an exclusion.
 *
 * R2.1 (v5): unattributable relative-spelled processes are carried in the
 * proof (PID, argv, reason) so the caller can surface them loudly — they are
 * never a silent freeze.
 */
export function evaluateSpawnProof(
  home: string,
  exclude: { readonly pid: number; readonly startIdentity: string } | null,
): SpawnProof {
  const scope = potentialHomeBridgeProcesses(home);
  if (!scope.complete) return { result: "inconclusive", unattributable: [] };
  const blockers = scope.blockers.filter(
    (p) => !(exclude !== null && p.pid === exclude.pid && p.startIdentity === exclude.startIdentity),
  );
  if (blockers.length === 0) return { result: "empty", unattributable: scope.unattributable };
  return { result: "occupied", count: blockers.length, unattributable: scope.unattributable };
}

/**
 * Classify the current bridge.lock into the reconciliation lock observation.
 * missing = no file; corrupt = unparseable/bad JSON; unreadable = other IO.
 */
export function buildLockObservation(home: string): LockObservation {
  let rawText: string | null = null;
  try {
    rawText = readFileSync(join(home, "bridge.lock"), "utf-8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    return { kind: "corrupt" };
  }
  const validation = validateBridgeLock(raw, LOCK_VALIDATOR_NEEDLES);
  const pid = typeof raw.pid === "number" ? raw.pid : 0;
  const startIdentity = typeof raw.startIdentity === "string" ? raw.startIdentity : "";
  const lastHeartbeat = typeof raw.lastHeartbeat === "number" && Number.isFinite(raw.lastHeartbeat) ? raw.lastHeartbeat : null;
  const lock: LockSnapshot = {
    pid,
    startIdentity,
    validatedOwner: validation.status === "valid",
    lastHeartbeat,
  };
  return { kind: "snapshot", lock };
}

function toRecords(home: string): readonly BridgeProcessRecord[] | "enumeration-failed" {
  const result = enumerateBridgeProcesses(home);
  if (!result.complete) return "enumeration-failed";
  return result.processes.map((p) => ({ pid: p.pid, startIdentity: p.startIdentity, exactTarget: p.exactTarget }));
}

export interface ReconciliationTickOutput {
  /** Machine-readable single line for the watchdog shell (fixed vocabulary). */
  readonly line: string;
  readonly decisionKind: string;
}

/**
 * One typed boundary invocation per watchdog tick: classify, persist or clear
 * the durable episode marker, and emit one fixed-vocabulary line. Unchanged
 * state produces no marker writes; the shell owns log de-duplication.
 */
export function runReconciliationTick(
  home: string,
  transition: TransitionState,
  previousHeartbeat: number | null,
  heartbeatAdvancedFlag: boolean,
): ReconciliationTickOutput {
  const now = Date.now();
  const processes = toRecords(home);
  const lock = buildLockObservation(home);
  const supRead = readSupervisorState(home);
  const episode = supRead.ok ? (supRead.state.ownershipEpisode ?? null) : null;

  const lockHeartbeat = lock.kind === "snapshot" ? lock.lock.lastHeartbeat : null;
  let livenessEvidence: LivenessEvidence | null = null;
  if (previousHeartbeat !== null || heartbeatAdvancedFlag) {
    livenessEvidence = {
      nowMs: now,
      staleMs: PRODUCTION_STALE_MS,
      heartbeatAdvanced: heartbeatAdvancedFlag ||
        (previousHeartbeat !== null && lockHeartbeat !== null && lockHeartbeat > previousHeartbeat),
    };
  }

  const decision = decideReconciliation({
    now,
    lock,
    processes,
    transition,
    candidates: [],
    ownershipEpisode: episode,
    livenessEvidence,
  });

  // Episode marker lifecycle: open on inconclusive (preserving the original
  // entry time while the SAME episode continues), clear otherwise.
  if (supRead.ok) {
    if (decision.kind === "ownership-inconclusive") {
      if (episode?.kind !== "ownership-inconclusive" || episode.reason !== decision.reason) {
        try {
          setOwnershipEpisode(home, {
            kind: "ownership-inconclusive",
            reason: decision.reason,
            since: episode?.kind === "ownership-inconclusive" ? episode.since : now,
          });
        } catch { /* marker is best-effort visibility */ }
      }
    } else if (episode !== null) {
      try { clearOwnershipEpisode(home); } catch { /* best-effort */ }
    }
  }

  let line: string;
  switch (decision.kind) {
    case "extra-candidate":
    case "contain-extra":
      line = `decision=${decision.kind} token=${decision.candidate.pid}:${decision.candidate.startIdentity} authority=${decision.authority}`;
      break;
    default:
      line = `decision=${decision.kind} token=- authority=-`;
      break;
  }
  return { line, decisionKind: decision.kind };
}

export type ContainmentResult =
  | { readonly outcome: "contained"; readonly via: "SIGTERM" | "SIGKILL" }
  | { readonly outcome: "unauthorized"; readonly why: string }
  | { readonly outcome: "vanished"; readonly why: string };

interface Authorization {
  readonly ok: true;
  readonly lastHeartbeat: number | null;
}
interface Rejection {
  readonly ok: false;
  readonly why: string;
  readonly vanished?: boolean;
}

/**
 * Fresh, complete authorization IMMEDIATELY before a signal (#1711 R6):
 * same PID + same start identity, exact literal argv (exactTarget implies a
 * full fresh enumeration succeeded), complete current snapshot, the named
 * authority, non-owner proof, and no transition fence.
 */
function authorizeOnce(
  home: string,
  pid: number,
  startIdentity: string,
  authority: ContainmentAuthority,
  heartbeatAdvanced: boolean,
  heartbeatBaseline: number | null = null,
): Authorization | Rejection {
  const processes = toRecords(home);
  if (processes === "enumeration-failed") return { ok: false, why: "enumeration-failed" };
  const record = processes.find((p) => p.pid === pid && p.startIdentity === startIdentity && p.exactTarget);
  if (!record) return { ok: false, why: "identity-or-argv-mismatch", vanished: true };

  const lock = buildLockObservation(home);
  if (lock.kind !== "snapshot") return { ok: false, why: `lock-${lock.kind}` };

  if (authority === "owner") {
    // Requires a DIFFERENT currently validated owner; the candidate itself
    // must not have become the owner.
    if (!lock.lock.validatedOwner) return { ok: false, why: "no-validated-owner" };
    if (lock.lock.pid === pid) return { ok: false, why: "candidate-is-owner" };
    return { ok: true, lastHeartbeat: lock.lock.lastHeartbeat };
  }

  // Liveness authority: all five R5 conditions re-checked now, conservatively
  // treating the heartbeat as advancing unless the CURRENT sample alone still
  // proves deep staleness.
  if (lock.lock.validatedOwner) return { ok: false, why: "owner-exists" };
  if (!isLivenessContainmentEligible(lock.lock, {
    nowMs: Date.now(),
    staleMs: PRODUCTION_STALE_MS,
    heartbeatAdvanced,
  })) {
    return { ok: false, why: "liveness-not-reconfirmed" };
  }
  if (heartbeatBaseline !== null && lock.lock.lastHeartbeat !== heartbeatBaseline) {
    return { ok: false, why: "heartbeat-advanced" };
  }
  return { ok: true, lastHeartbeat: lock.lock.lastHeartbeat };
}

/**
 * Contain one authorized candidate: graceful-first SIGTERM, three seconds of
 * continued identity checking, full reauthorization, then SIGKILL only for
 * the same unchanged qualified process. One target at a time; the caller
 * re-enumerates on its next tick.
 */
export async function containCandidate(
  home: string,
  pid: number,
  startIdentity: string,
  authority: ContainmentAuthority,
  transition: TransitionState,
  heartbeatAdvanced = false,
): Promise<ContainmentResult> {
  if (transition !== "stable") return { outcome: "unauthorized", why: "transition-fence-active" };

  const first = authorizeOnce(home, pid, startIdentity, authority, heartbeatAdvanced);
  if (!first.ok) {
    return first.vanished ? { outcome: "vanished", why: first.why } : { outcome: "unauthorized", why: first.why };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH"
      ? { outcome: "vanished", why: "sigterm-esrch" }
      : { outcome: "unauthorized", why: "sigterm-failed" };
  }

  const deadline = Date.now() + ESCALATION_GRACE_MS;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return { outcome: "contained", via: "SIGTERM" };
    const duringGrace = authorizeOnce(
      home,
      pid,
      startIdentity,
      authority,
      heartbeatAdvanced,
      authority === "liveness" ? first.lastHeartbeat : null,
    );
    if (!duringGrace.ok) {
      // SIGTERM was already authorized and delivered. A normal child can
      // disappear from the exact argv enumeration before its parent observes
      // the exit (notably while it is a zombie); no further signal is needed
      // and this is successful graceful containment, not permission to SIGKILL.
      if (duringGrace.vanished && duringGrace.why === "identity-or-argv-mismatch") {
        return { outcome: "contained", via: "SIGTERM" };
      }
      return duringGrace.vanished
        ? { outcome: "vanished", why: duringGrace.why }
        : { outcome: "unauthorized", why: duringGrace.why };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Full reauthorization before SIGKILL — same PID, same start identity, same
  // authority, current lock, no fence.
  const second = authorizeOnce(
    home,
    pid,
    startIdentity,
    authority,
    heartbeatAdvanced,
    authority === "liveness" ? first.lastHeartbeat : null,
  );
  if (!second.ok) {
    return second.vanished ? { outcome: "vanished", why: second.why } : { outcome: "unauthorized", why: second.why };
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH"
      ? { outcome: "vanished", why: "sigkill-esrch" }
      : { outcome: "unauthorized", why: "sigkill-failed" };
  }
  return { outcome: "contained", via: "SIGKILL" };
}
