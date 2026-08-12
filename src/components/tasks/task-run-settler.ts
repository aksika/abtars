import { logDebug, logInfo, logWarn, redactSecrets } from "../logger.js";
import { nextRunFromSchedule, settleActiveRun, setRunOutcome, readState } from "./task-state-store.js";
import { appendRunOnce, type TaskRunEvent } from "./task-history-store.js";
import { kanbanAttachResult, kanbanAttachProjectResult, kanbanComplete, kanbanFail, kanbanGetCard, kanbanSetDeliveryReady, kanbanSetProjectDeliveryReady, requireTaskDatabase } from "./kanban-board.js";
import { logTaskDebug } from "./task-log-ctx.js";
import { makeTaskFailure, decideFailurePolicy, formatTaskFailure, AUTO_PAUSE_FAILURE_THRESHOLD, AUTO_RESUME_COOLDOWN_MS } from "./task-failure.js";
import type { TaskFailureDiagnosticV1 } from "./task-failure.js";
import type { ScheduledTask } from "./task-types.js";
import type { ActiveTaskRun, DeferredAdmission, RunTerminalRequest, TaskRunPhase, TaskRuntimeState } from "./task-state-store.js";
import type { TaskOutcome } from "./task-history-store.js";

const TAG = "task-run-settler";
const RETRY_DELAY_MS = 10 * 60 * 1000;
const ADMISSION_MIN_DELAY_MS = 60 * 1000;
const MAX_ADMISSION_ATTEMPTS = 5;

/** #1610: shared local redact-and-bounds applied to every settlement string
 * field. Keeps operational `detail` (500) and user-facing `deliveryText`
 * (4,000) independently bounded inside this module only. */
function sanitizeText(text: string | undefined, bound: number): string | undefined {
  return text === undefined ? undefined : redactSecrets(text).slice(0, bound);
}

export type TerminalOutcome = TaskOutcome;

/** #1609: structured operator notice for the pause transition notification. */
export interface PauseNotice {
  taskId: string;
  category: string;
  code: string;
  failures: number;
  pausedAt: number;
  resumeAfterMs: number;
  resumeCommand: string;
}

export type SettleResult = "settled" | "late" | "duplicate";

export interface SettleOptions {
  /** #1520: any scheduled kind — system, script, and agent use one owner. */
  entry: ScheduledTask;
  run: ActiveTaskRun;
  outcome: TerminalOutcome;
  /** #1520: structured classification carried from the failing boundary. */
  diagnostic?: TaskFailureDiagnosticV1;
  detail?: string;
  /** #1610: bounded user-facing payload for successful scheduled one-shot
   * announce runs. Redacted and bound to 4,000 characters independently of
   * `detail`; populates the card's `result_summary` (precedence
   * deliveryText -> detail -> "completed"). */
  deliveryText?: string;
  resultPath?: string;
  cardId?: number;
  executionRef?: string;
  /** Admission hint: next admissible time (provider cooldown, system deferred). */
  retryAt?: number;
  /** #1520: release delivery only after ownership is won (agent/O cards). */
  releaseDelivery?: boolean;
  /** Accepted O projects are already done; attach a validated artifact instead of completing again. */
  attachResult?: boolean;
  /** Pause notification, emitted once per false→true transition. */
  onPaused?: (entryId: string, diagnostic: TaskFailureDiagnosticV1, notice: PauseNotice) => void;
  /**
   * #1588: failure cascade, fired exactly once per settled failed/timed_out
   * run — after the append-once write and the cleared reservation check, so
   * duplicate and late settlements never re-report.
   */
  onFailure?: (entryId: string, diagnostic: TaskFailureDiagnosticV1) => void;
  /**
   * #1539: the terminal fact's own occurrence time — card updated_at /
   * acceptance decision time, process exit time, or provider completion time.
   * A fact that predates the durable terminal request is accepted on its
   * merits even when observed afterward; without it, a deadline request wins
   * by settlement time.
   */
  factAt?: number;
}

/** #1539: one in-process terminal notification after winning settlement or
 * history-led repair. The coordinator removes handles idempotently and notifies
 * the queue; late/duplicate settlement may clean a matching local handle only. */
export type RunTerminalListener = (taskId: string, runId: string) => void;
const terminalListeners = new Set<RunTerminalListener>();
export function onRunTerminal(listener: RunTerminalListener): () => void {
  terminalListeners.add(listener);
  return () => {
    terminalListeners.delete(listener);
  };
}
export function clearRunTerminalListeners(): void {
  terminalListeners.clear();
}

function emitTerminal(taskId: string, runId: string): void {
  for (const listener of [...terminalListeners]) {
    try {
      listener(taskId, runId);
    } catch (err) {
      logDebug(TAG, `terminal listener error for ${taskId}/${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * #1539/#1600: normalize a proposed outcome against the DURABLE terminal request
 * (read from task state, never the caller's possibly-stale run object) before
 * the history append. A durable cancellation always wins; a deadline request
 * wins only when no child terminal fact occurred before the request itself
 * (facts with a known earlier `factAt` settle on their own merits); otherwise
 * the first child terminal fact wins.
 *
 * #1600: the fact-precedence boundary is `durableRequest.requestedAt`, the
 * instant the kill was decided — not `run.deadlineAt`. `deadlineAt` was only a
 * proxy for it that held while a kill fired exactly at the deadline; with a 2 h
 * ceiling and inactivity kills, the kill's own abort consequence would land
 * comfortably before `deadlineAt` and record as the cause of its own kill.
 * Ceiling kills are unchanged: the wake requests terminal at `deadlineAt`, so
 * the two instants coincide within a scan.
 */
function normalizeTerminal(
  outcome: TerminalOutcome,
  diagnostic: TaskFailureDiagnosticV1,
  run: ActiveTaskRun,
  durableRequest: RunTerminalRequest | undefined,
  detail: string | undefined,
  factAt: number | undefined,
): { outcome: TerminalOutcome; diagnostic: TaskFailureDiagnosticV1 } {
  if (!durableRequest) return { outcome, diagnostic };
  if (durableRequest.kind === "cancelled") {
    return {
      outcome: "cancelled",
      diagnostic: makeTaskFailure("interruption", "cancelled", run.phase ?? "settling", durableRequest.reason || "cancelled", "none"),
    };
  }
  if (factAt !== undefined && Number.isFinite(factAt) && factAt < durableRequest.requestedAt) {
    logInfo(TAG, `Run ${run.runId}: child terminal fact at ${factAt} preceded request ${durableRequest.requestedAt} — settling on its merits (deadline request set aside)`);
    return { outcome, diagnostic };
  }
  logInfo(TAG, `Run ${run.runId}: deadline request present and no pre-request terminal fact (factAt=${factAt === undefined ? "unavailable" : factAt}) — deadline verdict wins`);
  return {
    outcome: "failed",
    diagnostic: makeTaskFailure("interruption", "deadline_exceeded", run.phase ?? "executing", detail ?? "deadline exceeded", "none"),
  };
}

/**
 * #1520: the single scheduled-occurrence settler. Appends terminal/deferred
 * history first, then atomically clears the matching active reservation while
 * applying retry/admission/next-run/pause state in one write, then mutates the
 * owned card or releases delivery only after ownership is won. A stale or late
 * completion whose run has already settled is ignored.
 */
export function settleRunOnce(opts: SettleOptions): SettleResult {
  const { entry, run, outcome, detail, deliveryText, resultPath, cardId, executionRef, releaseDelivery, attachResult, onPaused, factAt } = opts;
  const finishedAt = Date.now();
  const safeDetail = sanitizeText(detail, 500);
  const safeDeliveryText = sanitizeText(deliveryText, 4000);

  if (executionRef) {
    logTaskDebug("task_settlement_processing", { task: entry.id, run: run.runId, exec: executionRef }, `outcome=${outcome}`);
  }

  // Pre-append read: within one process the queue is single-writer, so this
  // determines admission-deferral bounds before the event is recorded.
  const preState = readState(entry.id);
  const exhausted = outcome === "deferred" && opts.diagnostic?.category === "admission"
    ? admissionExhausted(preState, finishedAt, opts.retryAt)
    : false;
  const baseOutcome: TerminalOutcome = exhausted ? "failed" : outcome;
  const baseDiagnostic: TaskFailureDiagnosticV1 = exhausted
    ? makeTaskFailure("admission", "executor_unavailable", "queued",
      `executor unavailable after ${(preState?.deferredAdmission?.attempts ?? 0) + 1} deferral(s)`, "none")
    : (opts.diagnostic ?? synthesizeDiagnostic(outcome, detail, run.phase ?? "settling"));

  // #1539: terminal-request normalization — a durable cancellation or a
  // deadline verdict (when no child fact predates the deadline) overrides the
  // proposed outcome before the append-once write. The request is read from
  // durable state so precedence never depends on the caller's object.
  const { outcome: effectiveOutcome, diagnostic } = normalizeTerminal(baseOutcome, baseDiagnostic, run, preState?.activeRun?.terminalRequest, safeDetail, factAt);

  const historyRunId = appendRunOnce({
    runId: run.runId,
    taskId: entry.id,
    kind: entry.kind,
    trigger: run.trigger,
    startedAt: run.reservedAt,
    finishedAt,
    outcome: effectiveOutcome,
    detail: safeDetail,
    deliveryText: safeDeliveryText,
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
    emitTerminal(entry.id, run.runId);
    return "late";
  }
  const wasPaused = state.autoPaused === true;

  const patch = computeStatePatch(entry, run, effectiveOutcome, diagnostic, state, finishedAt, opts.retryAt);
  const cleared = settleActiveRun(entry.id, run.runId, patch);
  if (!cleared) {
    logDebug(TAG, `Late settlement for "${entry.id}" run=${run.runId} — reservation lost during settle`);
    emitTerminal(entry.id, run.runId);
    return "late";
  }
  // #1601: the winning settler records the durable terminal outcome on the
  // run row; a late/duplicate settler never reaches here.
  setRunOutcome(run.runId, effectiveOutcome);

  applyPostSettlementSideEffects({ cardId, outcome: effectiveOutcome, detail: safeDetail, deliveryText: safeDeliveryText, resultPath, diagnostic, releaseDelivery, attachResult });

  const nowPaused = patch.autoPaused === true;
  if (nowPaused && !wasPaused) {
    logWarn(TAG, `Auto-paused "${entry.id}" — ${formatTaskFailure(diagnostic)}`);
    onPaused?.(entry.id, diagnostic, {
      taskId: entry.id,
      category: diagnostic.category,
      code: diagnostic.code,
      failures: patch.consecutiveFailures ?? state.consecutiveFailures,
      pausedAt: patch.pausedAt ?? finishedAt,
      resumeAfterMs: AUTO_RESUME_COOLDOWN_MS,
      resumeCommand: `/task resume ${entry.id}`,
    });
  }

  // #1588: exactly-once failure cascade. Fired only after both guards above —
  // a duplicate settlement (append-once miss) and a late settlement (reservation
  // lost) return before reaching here, so a settled run reports at most once.
  // deferred and cancelled are deliberate non-failures and stay quiet.
  if (effectiveOutcome === "failed" || effectiveOutcome === "timed_out") {
    opts.onFailure?.(entry.id, diagnostic);
  }

  logInfo(TAG, `Run "${entry.id}" settled as ${effectiveOutcome}${nowPaused ? " (auto-paused)" : ""}`);
  emitTerminal(entry.id, run.runId);
  return "settled";
}

/**
 * Repair the state half of a history-first settlement after a crash. The
 * history row is authoritative, so this does not append a second row. Card
 * mutation remains downstream of winning the matching active reservation.
 */
export function settleRunFromHistory(entry: ScheduledTask, run: ActiveTaskRun, event: TaskRunEvent): boolean {
  const state = readState(entry.id);
  if (!state?.activeRun || state.activeRun.runId !== run.runId) return false;
  const diagnostic = event.diagnostic ?? synthesizeDiagnostic(event.outcome, event.detail, run.phase ?? "settling");
  const safeDetail = sanitizeText(event.detail, 500);
  const patch = computeStatePatch(entry, run, event.outcome, diagnostic, state, event.finishedAt);
  if (!settleActiveRun(entry.id, run.runId, patch)) return false;
  setRunOutcome(run.runId, event.outcome);

  applyPostSettlementSideEffects({
    cardId: event.kanbanCardId,
    outcome: event.outcome,
    detail: safeDetail,
    deliveryText: sanitizeText(event.deliveryText, 4000),
    resultPath: event.resultPath,
    diagnostic,
    releaseDelivery: event.outcome === "success",
    attachResult: Boolean(event.resultPath && entry.kind === "agent" && (entry.orchestration?.maxAgents ?? 1) > 1),
  });
  emitTerminal(entry.id, run.runId);
  return true;
}

function applyPostSettlementSideEffects(opts: {
  cardId?: number;
  outcome: TerminalOutcome;
  detail?: string;
  deliveryText?: string;
  resultPath?: string;
  diagnostic: TaskFailureDiagnosticV1;
  releaseDelivery?: boolean;
  attachResult?: boolean;
}): void {
  const { cardId, outcome, detail, deliveryText, resultPath, diagnostic, releaseDelivery, attachResult } = opts;
  if (cardId === undefined) return;
  if (outcome === "success" || outcome === "noop" || outcome === "skipped") {
    // #1610: the user-facing payload wins when present; operational detail and
    // the truthful fallback follow. Normal settlement and history-led repair
    // share this one selection.
    const summary = deliveryText || detail || "completed";
    // #1644: a supervised project root's artifact attach and delivery release
    // are fenced to the exact root/run/project-generation authority — a late
    // success callback for a terminal-blocked root, mismatched generation, or
    // failed run loses its predicate and mutates nothing. Plain cards keep the
    // existing unfenced settlement path.
    const card = kanbanGetCard(cardId);
    const projectAuthority = card && card.type === "O" && card.source === "task" && card.source_id != null
      ? { scheduledRunId: card.source_id }
      : card && card.type === "O" ? {} : undefined;
    if (projectAuthority !== undefined) {
      const generation = readProjectSupervisionGeneration(cardId) ?? 1;
      const authority = { projectGeneration: generation, ...projectAuthority };
      if (attachResult && resultPath) kanbanAttachProjectResult(cardId, resultPath, summary, authority);
      else kanbanComplete(cardId, resultPath ?? null, summary);
      if (releaseDelivery && outcome === "success") kanbanSetProjectDeliveryReady(cardId, authority);
    } else {
      if (attachResult && resultPath) kanbanAttachResult(cardId, resultPath, summary);
      else kanbanComplete(cardId, resultPath ?? null, summary);
      if (releaseDelivery && outcome === "success") kanbanSetDeliveryReady(cardId);
    }
  } else if (outcome !== "deferred") {
    // `unknown` still terminates its card: the project was not delivered and
    // the owner is gone, so a running card would orphan forever. The message
    // carries the owner_lost diagnostic — a truthful statement, not a claim
    // about whether the run's side effects completed.
    kanbanFail(cardId, formatTaskFailure(diagnostic).slice(0, 1000));
  }
}

/**
 * #1644: current supervision generation for a project root card, read on the
 * shared task database. Only used to build the delivery-side authority — the
 * mutating statements re-check generation inside their own predicates.
 */
function readProjectSupervisionGeneration(cardId: number): number | undefined {
  try {
    const db = requireTaskDatabase();
    const row = db.prepare(`SELECT generation FROM project_supervision WHERE project_card_id = ?`).get(cardId) as { generation: number } | undefined;
    return row?.generation;
  } catch {
    return undefined;
  }
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
    case "unknown":
      return makeTaskFailure("interruption", "owner_lost", phase,
        detail ?? "owner process exited before a durable terminal state; whether this run's side effects completed is unknown", "transient");
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
      // #1609: only a successful run resets the recovery episode; a failed
      // run must keep the automatic-resume cap intact.
      autoResumeCount: 0,
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

  // #1601: `unknown` is a terminal outcome that makes no success/failure
  // claim. It frees the reservation, advances the schedule, and records the
  // owner-lost incident — but it never counts a failure streak or auto-pauses,
  // because we do not know whether the interrupted run's side effects
  // completed. #1525 applies here too: a manual run reports only its own
  // outcome and must never advance the scheduled occurrence.
  if (outcome === "unknown") {
    if (run.trigger === "manual") {
      return {
        lastFinishedAt: finishedAt,
        lastIncident: diagnostic,
      };
    }
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

  const policy = decideFailurePolicy(diagnostic);

  // #1525: a manual run reports only its own outcome. The schedule belongs to
  // the scheduled trigger, so a user-initiated failure must not auto-pause the
  // definition, advance the next occurrence, consume the failure streak, or
  // discard a pending scheduled retry group. Deferral is excluded: it is the
  // same occurrence's bounded re-admission, not a failure verdict.
  if (run.trigger === "manual" && policy.action !== "defer") {
    return {
      lastFinishedAt: finishedAt,
      lastIncident: diagnostic,
    };
  }

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
  // #1609: raise the counted threshold from 3 to 5 consecutive failed run
  // groups; a success between failures resets the streak. Immediate-pause
  // classes (definition, permanent routing, unevidenceable contract) still
  // pause on their first counted group via pauseNow.
  const pause = pauseNow || failCount >= AUTO_PAUSE_FAILURE_THRESHOLD;
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
