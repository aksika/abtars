/**
 * due-sources.ts — #1539: lifecycle wake scheduler due sources for scheduled
 * runs. Each source lists durable due items (admission/retry times, active-run
 * deadlines, Kanban retry dates) and rescans durable state when woken. Wakes
 * are level-triggered: they request the owning pump, never carry payloads.
 */

import { readState } from "./task-state-store.js";
import { readEntries as dbReadEntries } from "./task-store.js";
import { getRun } from "./task-history-store.js";
import { settleRunFromHistory, settleRunOnce } from "./task-run-settler.js";
import { makeTaskFailure } from "./task-failure.js";
import { kanbanDueRetryItems, kanbanGetCard, type KanbanCard } from "./kanban-board.js";
import { abortProjectById } from "../reconciler.js";
import { ProjectReviewStore } from "../project-acceptance/project-review-store.js";
import { logAndSwallow } from "../log-and-swallow.js";
import type { LifecycleDueItem, LifecycleDueSource, LifecycleDueSourceId } from "../lifecycle-wake-scheduler.js";
import type { ScheduledRunCoordinator } from "./scheduled-run-coordinator.js";
import type { ScheduledTask } from "./task-types.js";

/** #1517: bounded grace after an owned cancellation request before fallback settlement. */
export const CANCELLATION_GRACE_MS = 30_000;

/** Exactly-once deadline settlement shared by the due source and recovery. */
export function settleExpiredRun(entry: ScheduledTask, run: NonNullable<ReturnType<typeof readState>>["activeRun"], detail: string, abortReason: string): void {
  if (!run) return;
  settleRunOnce({
    entry, run,
    outcome: "failed",
    diagnostic: makeTaskFailure("interruption", "deadline_exceeded", "executing", detail, "none"),
    detail,
  });
  // #1516: terminalize the interrupted project so its Orc/Worker state
  // cannot orphan after the scheduled run is settled.
  if (run.cardId !== undefined) {
    void abortProjectById(run.cardId, abortReason);
  }
}

/**
 * #1539: active-run deadline source. Replaces the heartbeat-driven
 * `reconcileActiveTaskRunsLive` deadline scan. Lists every non-terminal
 * occurrence's `deadlineAt`, plus a cancellation-grace follow-up item at
 * `terminalRequest.requestedAt + GRACE`. Waking requests the durable terminal
 * through the coordinator, which the settler normalizes by fact time.
 */
export function createRunDeadlineSource(coordinator: ScheduledRunCoordinator): LifecycleDueSource {
  const source: LifecycleDueSource = {
    id: "run-deadline",
    listDueItems(): LifecycleDueItem[] {
      const items: LifecycleDueItem[] = [];
      for (const entry of dbReadEntries()) {
        const run = readState(entry.id)?.activeRun;
        if (!run) continue;
        items.push({ key: `run:${run.runId}`, dueAt: run.deadlineAt });
        if (run.phase === "cancelling" && run.terminalRequest) {
          items.push({ key: `grace:${run.runId}`, dueAt: run.terminalRequest.requestedAt + CANCELLATION_GRACE_MS });
        }
      }
      return items;
    },
    wakeDue(now: number): void {
      for (const entry of dbReadEntries()) {
        const state = readState(entry.id);
        const run = state?.activeRun;
        if (!run) continue;

        const terminalHistory = getRun(run.runId);
        if (terminalHistory) {
          if (settleRunFromHistory(entry, run, terminalHistory)) {
            // history repair emits the terminal notification; nothing else to do
          }
          continue;
        }

        // #1539: a cancelling run whose durable request predates the grace
        // window settles once as deadline_exceeded — this is the fallback for
        // children that ignore cancel (system dispatches with no handle, a
        // stuck provider during the grace). Checked BEFORE the deadline branch
        // so a deadline-passed cancelling run is not shadowed forever.
        const graceItem = run.phase === "cancelling" && run.terminalRequest
          && run.terminalRequest.requestedAt + CANCELLATION_GRACE_MS <= now;
        if (graceItem) {
          settleExpiredRun(entry, run, "cancellation grace elapsed", "scheduled deadline passed");
          continue;
        }

        if (run.deadlineAt <= now) {
          coordinator.deadlineExpired(entry.id, run.runId, "deadline exceeded");
        }
      }
    },
  };
  return source;
}

/**
 * #1539: task admission/retry source. Lists every enabled task's earliest
 * durable admission/retry due time (`nextRunAt`, `retryAt`, deferred
 * `retryAt`). Waking requests one task tick; `checkCron` decides whether the
 * task is actually due. Mutations notify through `notifyTaskDueChanged`.
 */
export function createTaskAdmissionSource(wake: (now: number) => void | Promise<void>): LifecycleDueSource {
  return {
    id: "task-admission",
    listDueItems(): LifecycleDueItem[] {
      const items: LifecycleDueItem[] = [];
      for (const entry of dbReadEntries()) {
        if (!entry.enabled) continue;
        const state = readState(entry.id);
        if (!state) continue;
        if (state.activeRun) continue;
        const candidates = [state.nextRunAt, state.retryAt, state.deferredAdmission?.retryAt]
          .filter((t): t is number => typeof t === "number" && Number.isFinite(t));
        if (candidates.length === 0) continue;
        const dueAt = Math.min(...candidates);
        items.push({ key: `admission:${entry.id}`, dueAt });
      }
      return items;
    },
    wakeDue(now: number): void | Promise<void> {
      return wake(now);
    },
  };
}

/**
 * #1546 R1: shared active project-root supervision classification used by the
 * retry source and the legacy drain. A root card is a scheduled project only
 * with all durable identity facts: type O, no parent, task source, non-empty
 * source_id (the scheduled runId), and a non-terminal `project_supervision`
 * row. Unsupervised parentless cards and Worker children keep their domains.
 */
export function isActiveScheduledProjectRoot(card: KanbanCard): boolean {
  if (card.type !== "O" || card.parent_id !== null) return false;
  if (card.source !== "task" || !card.source_id || card.source_id.length === 0) return false;
  try {
    return new ProjectReviewStore().hasActiveProjectSupervision(card.id);
  } catch {
    return false;
  }
}

/**
 * #1539: Kanban retry source. Lists queued cards with a future `next_retry_at`.
 * Waking requests worker dispatch/reconciliation for every due card and, for
 * unsupervised cards, drains them through the Spin dispatch path — so due
 * retry eligibility never depends on the heartbeat. #1546: a due supervised
 * scheduled root routes to the Reconciler wake callback; only unsupervised
 * parentless cards reach the optional legacy drain. Retry, terminal, and
 * removal mutations notify through `setKanbanDueChangedHook`.
 */
export function createKanbanRetrySource(wakeCard: (cardId: number) => void, drainUnsupervised?: () => void): LifecycleDueSource {
  return {
    id: "kanban-retry",
    listDueItems(): LifecycleDueItem[] {
      return kanbanDueRetryItems();
    },
    wakeDue(_now: number): void {
      let unsupervisedDue = false;
      for (const item of kanbanDueRetryItems()) {
        if (item.dueAt > Date.now()) continue;
        const card = kanbanGetCard(Number(item.key.split(":")[1]));
        if (!card) continue;
        if (card.parent_id !== undefined && card.parent_id !== null) {
          wakeCard(card.id);
        } else if (isActiveScheduledProjectRoot(card)) {
          // #1546: the scheduled root is never dispatched as a legacy Spin O;
          // the Reconciler driver owns its continuation.
          wakeCard(card.id);
        } else {
          unsupervisedDue = true;
        }
      }
      if (unsupervisedDue && drainUnsupervised) {
        try {
          drainUnsupervised();
        } catch (err) {
          logAndSwallow("due-sources", "kanban-retry drain", err);
        }
      }
    },
  };
}

/** All source ids, in registration order. */
export const DUE_SOURCE_IDS: LifecycleDueSourceId[] = ["executor-lease", "kanban-retry", "task-admission", "run-deadline"];
