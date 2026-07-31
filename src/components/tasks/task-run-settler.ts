import { logDebug, logInfo, logWarn } from "../logger.js";
import { nextRunFromSchedule, settleActiveRun, readState } from "./task-state-store.js";
import { appendRunOnce } from "./task-history-store.js";
import { kanbanComplete, kanbanFail, kanbanSetDeliveryReady } from "./kanban-board.js";
import { logTaskDebug } from "./task-log-ctx.js";
import { makeTaskFailure, decideFailurePolicy, formatTaskFailure } from "./task-failure.js";
import type { TaskFailureDiagnosticV1 } from "./task-failure.js";
import type { ScheduledTask } from "./task-types.js";
import type { ActiveTaskRun, DeferredAdmission, TaskRunPhase, TaskRuntimeState } from "./task-state-store.js";
import type { TaskOutcome } from "./task-history-store.js";

const TAG = "task-run-settler";
const RETRY_DELAY_MS = 10 * 60 * 1000;
const ADMISSION_MIN_DELAY_MS = 60 * 1000;
const MAX_ADMISSION_ATTEMPTS = 5;

export type TerminalOutcome = TaskOutcome;

export type SettleResult = "settled" | "late" | "duplicate";

export interface SettleOptions {
  /** #1520: any scheduled kind — system, script, and agent use one owner. */
  entry: ScheduledTask;
  run: ActiveTaskRun;
  outcome: TerminalOutcome;
  /** #1520: structured classification carried from the failing boundary. */
  diagnostic?: TaskFailureDiagnosticV1;
  detail?: string;
  resultPath?: string;
  cardId?: number;
  executionRef?: string;
  /** Admission hint: next admissible time (provider cooldown, system deferred). */
  retryAt?: number;
  /** #1520: release delivery only after ownership is won (agent/O cards). */
  releaseDelivery?: boolean;
  /** Pause notification, emitted once per false→true transition. */
  onPaused?: (entryId: string, diagnostic: TaskFailureDiagnosticV1) => void;
}

/**
 * #1520: the single scheduled-occurrence settler. Appends terminal/deferred
 * history first, then atomically clears the matching active reservation while
 * applying retry/admission/next-run/pause state in one write, then mutates the
 * owned card or releases delivery only after ownership is won. A stale or late
 * completion whose run has already settled is ignored.
 */
export function settleRunOnce(opts: SettleOptions): SettleResult {
  const { entry, run, outcome, detail, resultPath, cardId, executionRef, releaseDelivery, onPaused } = opts;
  const finishedAt = Date.now();

  if (executionRef) {
    logTaskDebug("task_settlement_processing", { task: entry.id, run: run.runId, exec: executionRef }, `outcome=${outcome}`);
  }

  // Pre-append read: within one process the queue is single-writer, so this
  // determines admission-deferral bounds before the event is recorded.
  const preState = readState(entry.id);
  const exhausted = outcome === "deferred" && opts.diagnostic?.category === "admission"
    ? admissionExhausted(preState, finishedAt, opts.retryAt)
    : false;
  const effectiveOutcome: TerminalOutcome = exhausted ? "failed" : outcome;
  const diagnostic: TaskFailureDiagnosticV1 = exhausted
    ? makeTaskFailure("admission", "executor_unavailable", "queued",
      `executor unavailable after ${(preState?.deferredAdmission?.attempts ?? 0) + 1} deferral(s)`, "none")
    : (opts.diagnostic ?? synthesizeDiagnostic(outcome, detail, run.phase ?? "settling"));

  const historyRunId = appendRunOnce({
    runId: run.runId,
    taskId: entry.id,
    kind: entry.kind,
    trigger: run.trigger,
    startedAt: run.reservedAt,
    finishedAt,
    outcome: effectiveOutcome,
    detail: detail?.slice(0, 500),
    resultPath,
    kanbanCardId: cardId,
    groupId: run.groupId,
    // #1520: every unsuccessful or deferred run records the structured
    // diagnostic; healthy runs carry no incident.
    ...(effectiveOutcome === "success" || effectiveOutcome === "noop" || effectiveOutcome === "skipped" ? {} : { diagnostic }),
  });
  if (!historyRunId) {
    logDebug(TAG, `Duplicate history prevented for "${entry.id}" run=${run.runId}`);
    return "duplicate";
  }

  // Ownership read AFTER the append-once write: this is the serialization
  // point, so a concurrent settler for the same run cannot exist.
  const state = readState(entry.id);
  if (!state?.activeRun || state.activeRun.runId !== run.runId) {
    logDebug(TAG, `Late settlement for "${entry.id}" run=${run.runId} — reservation already cleared`);
    return "late";
  }
  const wasPaused = state.autoPaused === true;

  const patch = computeStatePatch(entry, run, effectiveOutcome, diagnostic, state, finishedAt, opts.retryAt);
  const cleared = settleActiveRun(entry.id, run.runId, patch);
  if (!cleared) {
    logDebug(TAG, `Late settlement for "${entry.id}" run=${run.runId} — reservation lost during settle`);
    return "late";
  }

  // Post-ownership side effects.
  if (cardId !== undefined) {
    if (effectiveOutcome === "success" || effectiveOutcome === "noop" || effectiveOutcome === "skipped") {
      const summary = detail || "completed";
      kanbanComplete(cardId, resultPath ?? null, summary);
      if (releaseDelivery && effectiveOutcome === "success") kanbanSetDeliveryReady(cardId);
    } else if (effectiveOutcome !== "deferred") {
      kanbanFail(cardId, formatTaskFailure(diagnostic).slice(0, 1000));
    }
  }

  const nowPaused = patch.autoPaused === true;
  if (nowPaused && !wasPaused) {
    logWarn(TAG, `Auto-paused "${entry.id}" — ${formatTaskFailure(diagnostic)}`);
    onPaused?.(entry.id, diagnostic);
  }

  logInfo(TAG, `Run "${entry.id}" settled as ${effectiveOutcome}${nowPaused ? " (auto-paused)" : ""}`);
  return "settled";
}

function admissionExhausted(state: TaskRuntimeState | null, finishedAt: number, retryAtHint?: number): boolean {
  const existing = state?.deferredAdmission;
  // "At most five deferrals": attempts 1..5 defer; the 6th reservation hits
  // the bound and terminalizes the occurrence as executor_unavailable.
  const attempts = (existing?.attempts ?? 0) + 1;
  if (attempts > MAX_ADMISSION_ATTEMPTS) return true;
  const deadlineAt = existing?.deadlineAt;
  if (deadlineAt === undefined) return false;
  const hinted = retryAtHint && retryAtHint > 0 ? retryAtHint : finishedAt + ADMISSION_MIN_DELAY_MS;
  const retryAt = Math.min(Math.max(hinted, finishedAt + ADMISSION_MIN_DELAY_MS), deadlineAt);
  return retryAt >= deadlineAt;
}

function synthesizeDiagnostic(outcome: TerminalOutcome, detail: string | undefined, phase: TaskRunPhase | "delivery"): TaskFailureDiagnosticV1 {
  switch (outcome) {
    case "definition_failed":
      return makeTaskFailure("definition", "invalid_definition", phase, detail ?? "definition failed", "permanent");
    case "timed_out":
      return makeTaskFailure("interruption", "timed_out", phase, detail ?? "run timed out", "none");
    case "cancelled":
      return makeTaskFailure("interruption", "cancelled", phase, detail ?? "cancelled", "none");
    case "deferred":
      return makeTaskFailure("admission", "executor_unavailable", phase, detail ?? "deferred", "transient");
    case "failed":
      return makeTaskFailure("execution", "model_error", phase, detail ?? "failed", "none");
    default:
      return makeTaskFailure("execution", "model_error", phase, detail ?? outcome, "none");
  }
}

/** Policy decision applied in one atomic state write. */
function computeStatePatch(
  entry: ScheduledTask,
  run: ActiveTaskRun,
  outcome: TerminalOutcome,
  diagnostic: TaskFailureDiagnosticV1,
  state: TaskRuntimeState,
  finishedAt: number,
  retryAtHint?: number,
): Partial<TaskRuntimeState> {
  if (outcome === "success") {
    return {
      lastFinishedAt: finishedAt,
      lastIncident: undefined,
      ...nextRunFromSchedule(entry),
      retrying: false,
      retryGroupId: undefined,
      retryAttempt: undefined,
      priorFailure: undefined,
      consecutiveFailures: 0,
      consecutiveDeferrals: 0,
      deferredAdmission: undefined,
    };
  }
  if (outcome === "noop" || outcome === "skipped") {
    // A noop is healthy: it advances the schedule but does not erase the
    // latest incident or reset failure counting. Omitting lastIncident from
    // the patch preserves the existing incident untouched.
    return {
      lastFinishedAt: finishedAt,
      ...nextRunFromSchedule(entry),
      retrying: false,
      retryGroupId: undefined,
      retryAttempt: undefined,
      priorFailure: undefined,
      deferredAdmission: undefined,
    };
  }

  const policy = decideFailurePolicy(diagnostic);

  if (policy.action === "defer") {
    // The occurrence's bounded deferral was already exhausted: the settler
    // flipped the event to failed/executor_unavailable before appending, so
    // a terminal admission outcome counts one failed group — never re-defers.
    if (outcome === "failed" && diagnostic.code === "executor_unavailable") {
      return failurePatch(entry, diagnostic, state, finishedAt, false);
    }
    return deferPatch(run, diagnostic, state, finishedAt, retryAtHint);
  }
  if (policy.action === "clear") {
    return {
      lastFinishedAt: finishedAt,
      lastIncident: diagnostic,
      ...nextRunFromSchedule(entry),
      retrying: false,
      retryGroupId: undefined,
      retryAttempt: undefined,
      priorFailure: undefined,
      deferredAdmission: undefined,
    };
  }
  if (policy.action === "retry") {
    // One delayed retry in the same run group, only for the first attempt.
    if (run.attempt === 1) {
      const retryAt = finishedAt + RETRY_DELAY_MS;
      return {
        lastFinishedAt: finishedAt,
        lastIncident: diagnostic,
        nextRunAt: retryAt,
        retryAt,
        retrying: true,
        retryGroupId: run.groupId,
        retryAttempt: 1,
        priorFailure: formatTaskFailure(diagnostic).slice(0, 200),
        deferredAdmission: undefined,
      };
    }
    // Transient fault on the retry attempt: count one failed group.
    return failurePatch(entry, diagnostic, state, finishedAt, false);
  }
  return failurePatch(entry, diagnostic, state, finishedAt, policy.pauseNow);
}

function failurePatch(
  entry: ScheduledTask,
  diagnostic: TaskFailureDiagnosticV1,
  state: TaskRuntimeState,
  finishedAt: number,
  pauseNow: boolean,
): Partial<TaskRuntimeState> {
  const failCount = (state.consecutiveFailures ?? 0) + 1;
  const pause = pauseNow || failCount >= 3;
  return {
    lastFinishedAt: finishedAt,
    lastIncident: diagnostic,
    ...nextRunFromSchedule(entry),
    retrying: false,
    retryGroupId: undefined,
    retryAttempt: undefined,
    priorFailure: undefined,
    consecutiveFailures: failCount,
    deferredAdmission: undefined,
    ...(pause ? { autoPaused: true, pausedAt: Date.now() } : {}),
  };
}

/** Bounded admission deferral: same occurrence, durable, capped at five attempts and the run deadline. */
function deferPatch(
  run: ActiveTaskRun,
  diagnostic: TaskFailureDiagnosticV1,
  state: TaskRuntimeState,
  finishedAt: number,
  retryAtHint?: number,
): Partial<TaskRuntimeState> {
  const existing = state.deferredAdmission;
  const attempts = (existing?.attempts ?? 0) + 1;
  const deferred: DeferredAdmission = {
    groupId: existing?.groupId ?? run.groupId,
    occurrenceAt: existing?.occurrenceAt ?? run.occurrenceAt,
    deadlineAt: existing?.deadlineAt ?? run.deadlineAt,
    attempts,
    retryAt: finishedAt + ADMISSION_MIN_DELAY_MS,
    diagnostic,
  };
  if (retryAtHint && retryAtHint > 0) {
    deferred.retryAt = Math.min(Math.max(retryAtHint, finishedAt + ADMISSION_MIN_DELAY_MS), deferred.deadlineAt);
  }
  return {
    lastFinishedAt: finishedAt,
    lastIncident: diagnostic,
    nextRunAt: deferred.retryAt,
    deferredAdmission: deferred,
  };
}
