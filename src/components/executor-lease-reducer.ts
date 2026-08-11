import type {
  ExecutorProgressFactV1,
  AttemptLeaseSnapshotV1,
  LeasePolicy,
} from "./executor-progress.js";
import { computeSemanticFingerprint } from "./executor-progress.js";

export interface PendingInputResolver {
  isOpenRequest(attemptId: string, generation: number, requestId: string): boolean;
}

export function createInitialSnapshot(
  fact: ExecutorProgressFactV1,
  cardId: number,
  policy: LeasePolicy,
  now: number,
  hardDeadlineAt?: number,
): AttemptLeaseSnapshotV1 {
  const nowStr = new Date(now).toISOString();
  const livenessDeadline = now + policy.livenessMs;
  const progressDeadline = now + policy.meaningfulProgressMs;

  const clamp = (v: number) => hardDeadlineAt !== undefined ? Math.min(v, hardDeadlineAt) : v;

  return {
    schemaVersion: 1,
    attemptId: fact.attempt_id,
    cardId,
    claimGeneration: fact.claim_generation,
    executorKind: fact.executor.kind,
    executorId: fact.executor.id,
    highWaterSequence: 0,
    stateVersion: 1,
    semanticState: fact.kind,
    semanticFingerprint: computeSemanticFingerprint(fact),
    lastMilestoneId: fact.kind === "durable_milestone" ? fact.payload.milestone_id : undefined,
    lastReceivedAt: nowStr,
    lastLivenessAt: nowStr,
    lastMeaningfulProgressAt: nowStr,
    livenessDeadlineAt: new Date(clamp(livenessDeadline)).toISOString(),
    progressDeadlineAt: new Date(clamp(progressDeadline)).toISOString(),
    evaluation: {
      phase: "healthy",
      inspectionCount: 0,
      version: 0,
    },
    updatedAt: nowStr,
  };
}

export function reduceFact(
  snapshot: AttemptLeaseSnapshotV1,
  fact: ExecutorProgressFactV1,
  policy: LeasePolicy,
  now: number,
  hardDeadlineAt?: number,
  inputResolver?: PendingInputResolver,
): AttemptLeaseSnapshotV1 {
  const nowStr = new Date(now).toISOString();
  const fingerprint = computeSemanticFingerprint(fact);
  const next = structuredClone(snapshot);
  next.lastReceivedAt = nowStr;
  next.semanticFingerprint = fingerprint;
  next.stateVersion++;

  const clamp = (v: number) => hardDeadlineAt !== undefined ? Math.min(v, hardDeadlineAt) : v;

  switch (fact.kind) {
    case "alive": {
      next.semanticState = "alive";
      next.lastLivenessAt = nowStr;
      next.livenessDeadlineAt = new Date(clamp(now + policy.livenessMs)).toISOString();
      break;
    }

    case "producing_output": {
      next.semanticState = "producing_output";
      next.lastLivenessAt = nowStr;
      next.livenessDeadlineAt = new Date(clamp(now + policy.livenessMs)).toISOString();

      const units = fact.payload.progress_units;
      if (units !== undefined && units > (next.outputUnits ?? 0)) {
        next.outputUnits = units;
        if (!next.outputOnlySince) {
          next.outputOnlySince = nowStr;
        }
        const outputDeadline = new Date(next.outputOnlySince).getTime() + policy.outputOnlyProgressCapMs;
        if (now <= outputDeadline) {
          next.lastMeaningfulProgressAt = nowStr;
          next.progressDeadlineAt = new Date(clamp(now + policy.meaningfulProgressMs)).toISOString();
        }
      }
      break;
    }

    case "using_tool": {
      const opId = fact.payload.operation_id;
      if (!opId) break;

      if (fact.phase === "start") {
        if (!next.operation || next.operation.id !== opId) {
          const declaredTimeout = fact.payload.expected_timeout_ms ?? policy.maxToolSilenceMs;
          const absSilence = now + Math.min(declaredTimeout, policy.maxToolSilenceMs);
          next.operation = {
            id: opId,
            label: fact.payload.operation_label ?? opId,
            startedAt: nowStr,
            absoluteSilenceDeadlineAt: new Date(clamp(absSilence)).toISOString(),
          };
        }
        next.semanticState = "using_tool";
        next.lastLivenessAt = nowStr;
        next.livenessDeadlineAt = new Date(clamp(now + policy.livenessMs)).toISOString();
      } else if (fact.phase === "advance") {
        if (next.operation && next.operation.id === opId) {
          const newUnits = fact.payload.progress_units;
          const newObsId = fact.payload.observation_id;
          if ((newUnits !== undefined && newUnits > (next.operation.progressUnits ?? 0)) ||
              (newObsId && newObsId !== next.operation.lastObservationId)) {
            next.operation.progressUnits = newUnits ?? next.operation.progressUnits;
            next.operation.lastObservationId = newObsId ?? next.operation.lastObservationId;
          }
          next.lastLivenessAt = nowStr;
          next.livenessDeadlineAt = new Date(clamp(now + policy.livenessMs)).toISOString();
        }
        next.semanticState = "using_tool";
      } else if (fact.phase === "end") {
        if (next.operation && next.operation.id === opId) {
          if (fact.payload.observation_id && fact.payload.observation_id !== next.operation.lastObservationId) {
            next.lastMeaningfulProgressAt = nowStr;
            next.progressDeadlineAt = new Date(clamp(now + policy.meaningfulProgressMs)).toISOString();
          }
          next.operation = undefined;
        }
        next.semanticState = "alive";
        next.lastLivenessAt = nowStr;
        next.livenessDeadlineAt = new Date(clamp(now + policy.livenessMs)).toISOString();
        next.outputOnlySince = undefined;
        next.outputUnits = undefined;
      }
      break;
    }

    case "durable_milestone": {
      const mid = fact.payload.milestone_id;
      if (mid && mid !== next.lastMilestoneId) {
        next.lastMilestoneId = mid;
        next.lastMeaningfulProgressAt = nowStr;
        next.progressDeadlineAt = new Date(clamp(now + policy.meaningfulProgressMs)).toISOString();
        next.outputOnlySince = undefined;
        next.outputUnits = undefined;
      }
      next.semanticState = "durable_milestone";
      next.lastLivenessAt = nowStr;
      next.livenessDeadlineAt = new Date(clamp(now + policy.livenessMs)).toISOString();
      break;
    }

    case "awaiting_input": {
      if (fact.phase === "start") {
        const reqId = fact.payload.input_request_id;
        if (reqId && inputResolver && inputResolver.isOpenRequest(fact.attempt_id, fact.claim_generation, reqId)) {
          next.awaitingInput = {
            requestId: reqId,
            since: nowStr,
            deadlineAt: new Date(clamp(now + policy.awaitingInputMs)).toISOString(),
          };
        }
        next.semanticState = "awaiting_input";
      } else if (fact.phase === "resolved") {
        next.awaitingInput = undefined;
        next.lastMeaningfulProgressAt = nowStr;
        next.progressDeadlineAt = new Date(clamp(now + policy.meaningfulProgressMs)).toISOString();
        next.semanticState = "alive";
        next.outputOnlySince = undefined;
        next.outputUnits = undefined;
      }
      next.lastLivenessAt = nowStr;
      next.livenessDeadlineAt = new Date(clamp(now + policy.livenessMs)).toISOString();
      break;
    }

    case "stalled": {
      next.semanticState = "stalled";
      next.lastLivenessAt = nowStr;
      next.livenessDeadlineAt = new Date(clamp(now + policy.livenessMs)).toISOString();
      next.nextEvaluationAt = nowStr;
      break;
    }
  }

  next.updatedAt = nowStr;
  return next;
}
