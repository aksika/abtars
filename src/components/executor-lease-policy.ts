import type {
  AttemptLeaseSnapshotV1,
  LeasePolicy,
  LeaseDecision,
  LeaseReason,
} from "./executor-progress.js";

export function evaluateLease(
  snapshot: AttemptLeaseSnapshotV1,
  now: number,
  policy: LeasePolicy,
  hardDeadlineAt?: number,
): LeaseDecision {
  if (snapshot.evaluation.phase === "closed" || snapshot.closedAt) {
    return { action: "closed" };
  }

  if (snapshot.evaluation.phase === "cancel_requested") {
    return { action: "cancel", reason: snapshot.evaluation.reason };
  }

  if (snapshot.evaluation.phase === "inspect_grace" &&
      snapshot.evaluation.reason === "inspection_unknown_exhausted" &&
      snapshot.evaluation.inspectionCount >= policy.maxUnknownInspections) {
    return { action: "cancel", reason: "inspection_unknown_exhausted" };
  }

  if (hardDeadlineAt !== undefined && now >= hardDeadlineAt) {
    return { action: "cancel", reason: "hard_deadline", nextAt: undefined };
  }

  const state = snapshot.semanticState as string;
  if (state === "stalled") {
    return { action: "cancel", reason: "explicit_stall" };
  }

  if (snapshot.semanticState === "awaiting_input" && snapshot.awaitingInput) {
    const inputDeadline = new Date(snapshot.awaitingInput.deadlineAt).getTime();
    if (now >= inputDeadline) {
      return { action: "cancel", reason: "awaiting_input_expired" };
    }
    return { action: "healthy", nextAt: new Date(Math.min(inputDeadline, hardDeadlineAt ?? inputDeadline)).toISOString() };
  }

  if (snapshot.operation) {
    const toolDeadline = new Date(snapshot.operation.absoluteSilenceDeadlineAt).getTime();
    if (now >= toolDeadline) {
      return { action: "cancel", reason: "tool_silence_expired" };
    }
    return { action: "healthy", nextAt: new Date(Math.min(toolDeadline, hardDeadlineAt ?? toolDeadline)).toISOString() };
  }

  const livenessDeadline = Math.min(new Date(snapshot.livenessDeadlineAt).getTime(), hardDeadlineAt ?? Infinity);
  const progressDeadline = Math.min(new Date(snapshot.progressDeadlineAt).getTime(), hardDeadlineAt ?? Infinity);
  const livenessExpired = now >= livenessDeadline;
  const progressExpired = now >= progressDeadline;
  const livenessWarning = !livenessExpired && now >= livenessDeadline - policy.warningBeforeMs;
  const progressWarning = !progressExpired && now >= progressDeadline - policy.warningBeforeMs;

  const isWarning = livenessWarning || progressWarning;
  const effectiveReason: LeaseReason = progressExpired ? "progress_expired" : "liveness_expired";

  if (livenessExpired || progressExpired) {
    const evalPhase = snapshot.evaluation.phase;

    if (evalPhase === "healthy") {
      return { action: "warning", reason: effectiveReason, nextAt: new Date(now).toISOString() };
    }

    if (evalPhase === "inspect_grace") {
      const graceDeadline = snapshot.evaluation.graceDeadlineAt
        ? new Date(snapshot.evaluation.graceDeadlineAt).getTime()
        : now;
      if (now >= graceDeadline) return { action: "cancel", reason: effectiveReason };
      return { action: "healthy", nextAt: snapshot.evaluation.graceDeadlineAt };
    }

    if (evalPhase === "warning") {
      const shouldSkipInspect = snapshot.semanticState === "stalled";
      if (shouldSkipInspect) {
        return { action: "cancel", reason: effectiveReason };
      }
      return { action: "inspect", reason: effectiveReason };
    }

    if (evalPhase === "inspecting") {
      return { action: "inspect", reason: effectiveReason };
    }

    if (evalPhase === "inspect_due") {
      return { action: "inspect", reason: effectiveReason };
    }

    return { action: "cancel", reason: effectiveReason };
  }

  if (isWarning) {
    return {
      action: "warning",
      reason: effectiveReason,
      nextAt: new Date(Math.min(livenessDeadline, progressDeadline)).toISOString(),
    };
  }

  const evalAt = Math.min(livenessDeadline - policy.warningBeforeMs, progressDeadline - policy.warningBeforeMs);
  return {
    action: "healthy",
    nextAt: new Date(evalAt).toISOString(),
  };
}

export function applyInspectionOutcome(
  snapshot: AttemptLeaseSnapshotV1,
  outcome: "running" | "terminal" | "unknown",
  now: number,
  policy: LeasePolicy,
  hardDeadlineAt?: number,
): AttemptLeaseSnapshotV1 {
  const next = structuredClone(snapshot);
  const nowStr = new Date(now).toISOString();

  next.evaluation.inspectionCount++;
  next.evaluation.lastInspectionOutcome = outcome;
  next.evaluation.version++;
  next.stateVersion++;
  next.updatedAt = nowStr;

  const clamp = (v: number) => hardDeadlineAt !== undefined ? Math.min(v, hardDeadlineAt) : v;

  switch (outcome) {
    case "running": {
      next.lastLivenessAt = nowStr;
      next.livenessDeadlineAt = new Date(clamp(now + policy.livenessMs)).toISOString();
      const progressDeadline = new Date(next.lastMeaningfulProgressAt).getTime() + policy.meaningfulProgressMs;
      if (now >= progressDeadline) {
        next.evaluation.phase = "inspect_grace";
        next.evaluation.graceDeadlineAt = new Date(clamp(now + policy.inspectGraceMs)).toISOString();
        next.nextEvaluationAt = new Date(clamp(now + policy.inspectGraceMs)).toISOString();
      } else {
        next.evaluation.phase = "healthy";
        next.progressDeadlineAt = new Date(clamp(progressDeadline)).toISOString();
        next.nextEvaluationAt = new Date(clamp(now + policy.livenessMs - policy.warningBeforeMs)).toISOString();
      }
      break;
    }
    case "terminal": {
      next.evaluation.phase = "closed";
      next.closedAt = nowStr;
      next.closeReason = "inspection_terminal";
      next.nextEvaluationAt = undefined;
      break;
    }
    case "unknown": {
      if (next.evaluation.inspectionCount >= policy.maxUnknownInspections) {
        // Leave the lifecycle transition to the Reconciler's cancellation CAS.
        // This is a durable cancel_due marker, not a half-committed intent.
        next.evaluation.phase = "inspect_grace";
        next.evaluation.reason = "inspection_unknown_exhausted";
        next.evaluation.graceDeadlineAt = nowStr;
        next.nextEvaluationAt = nowStr;
      } else {
        next.evaluation.phase = "inspect_grace";
        next.evaluation.graceDeadlineAt = new Date(clamp(now + policy.inspectGraceMs)).toISOString();
        next.nextEvaluationAt = new Date(clamp(now + policy.inspectGraceMs)).toISOString();
      }
      break;
    }
  }

  return next;
}
