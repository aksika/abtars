import { logDebug, logInfo, logWarn } from "../logger.js";
import { advanceNextRun, updateState, settleActiveRun, incrementFailures, setAutoPaused, resetFailures } from "./task-state-store.js";
import { appendRunOnce, hasRun } from "./task-history-store.js";
import { kanbanComplete, kanbanFail } from "./kanban-board.js";
import { logTaskDebug } from "./task-log-ctx.js";
import type { ScheduledTask } from "./task-types.js";
import type { ActiveTaskRun } from "./task-state-store.js";

const TAG = "task-run-settler";
const RETRY_DELAY_MS = 10 * 60 * 1000;

export type TerminalOutcome = "success" | "definition_failed" | "failed" | "timed_out" | "cancelled" | "deferred" | "noop" | "skipped";

export type SettleResult = "settled" | "late" | "duplicate";

export interface SettleOptions {
  entry: ScheduledTask & { kind: "agent" };
  run: ActiveTaskRun;
  outcome: TerminalOutcome;
  detail?: string;
  resultPath?: string;
  cardId?: number;
  executionRef?: string;
}

export function settleRunOnce(opts: SettleOptions): SettleResult {
  const { entry, run, outcome, detail, resultPath, cardId, executionRef } = opts;
  const finishedAt = Date.now();

  if (hasRun(run.runId)) {
    logDebug(TAG, `Stale settlement ignored for "${entry.id}" run=${run.runId}`);
    return "duplicate";
  }

  if (executionRef) {
    logTaskDebug("task_settlement_processing", { task: entry.id, run: run.runId, exec: executionRef }, `outcome=${outcome}`);
  }

  const historyRunId = appendRunOnce({
    runId: run.runId,
    taskId: entry.id,
    kind: entry.kind,
    trigger: run.trigger,
    startedAt: run.reservedAt,
    finishedAt,
    outcome,
    detail: detail?.slice(0, 500),
    resultPath,
    kanbanCardId: cardId,
    groupId: run.groupId,
  });
  if (!historyRunId) {
    logDebug(TAG, `Duplicate history prevented for "${entry.id}" run=${run.runId}`);
    return "duplicate";
  }

  settleActiveRun(entry.id, run.runId, {});

  if (outcome === "success" || outcome === "noop" || outcome === "skipped") {
    advanceNextRun(entry.id, entry.schedule);
    updateState(entry.id, { lastFinishedAt: finishedAt, retrying: false, retryGroupId: undefined, retryAttempt: undefined, priorFailure: undefined });
    if (outcome === "success") resetFailures(entry.id);

    if (cardId) {
      const summary = detail || "completed";
      kanbanComplete(cardId, resultPath ?? null, summary);
    }
    logInfo(TAG, `Run "${entry.id}" settled as ${outcome}`);
  } else if (outcome === "deferred") {
    updateState(entry.id, { lastFinishedAt: finishedAt });
    logInfo(TAG, `Run "${entry.id}" deferred`);
  } else if (outcome === "definition_failed") {
    advanceNextRun(entry.id, entry.schedule);
    updateState(entry.id, { lastFinishedAt: finishedAt, retrying: false, retryGroupId: undefined, retryAttempt: undefined, priorFailure: undefined });
    if (cardId) kanbanFail(cardId, detail || "definition_failed");
    logWarn(TAG, `Run "${entry.id}" settled as definition_failed: ${detail}`);
  } else {
    if (run.attempt === 1 && entry.schedule && outcome !== "timed_out" && outcome !== "cancelled") {
      const retryAt = finishedAt + RETRY_DELAY_MS;
      updateState(entry.id, { lastFinishedAt: finishedAt, nextRunAt: retryAt, retryAt, retrying: true, retryGroupId: run.groupId, retryAttempt: 1, priorFailure: (detail || "").slice(0, 200) });
      logInfo(TAG, `Retry scheduled for "${entry.id}": attempt 1 failed, retry in ${RETRY_DELAY_MS / 60000}min`);
      logTaskDebug("task_retry_scheduled", { task: entry.id, run: run.groupId, attempt: 1 });
    } else {
      advanceNextRun(entry.id, entry.schedule);
      updateState(entry.id, { retrying: false, retryGroupId: undefined, retryAttempt: undefined, priorFailure: undefined, lastFinishedAt: finishedAt });
      const failCount = incrementFailures(entry.id);
      if (failCount >= 3) {
        setAutoPaused(entry.id, true);
        logWarn(TAG, `Auto-paused "${entry.id}" after ${failCount} run groups failed`);
      }
    }
    if (cardId) kanbanFail(cardId, (detail || "failed").slice(0, 1000));
    logInfo(TAG, `Run "${entry.id}" settled as ${outcome}`);
  }

  return "settled";
}
