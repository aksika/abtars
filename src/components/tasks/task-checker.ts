import { logAndSwallow } from "../log-and-swallow.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logInfo, logWarn, logTrace } from "../logger.js";
import { readEntries as dbReadEntries } from "./task-store.js";
import { advanceNextRun, createRunId, readState, reserveRun, updateActiveRun } from "./task-state-store.js";
import { todaySuccessCount, getRun } from "./task-history-store.js";
import { kanbanGetCard } from "./kanban-board.js";
import { settleRunFromHistory, settleRunOnce } from "./task-run-settler.js";
import { makeTaskFailure } from "./task-failure.js";
import { abortProjectById } from "../reconciler.js";
import type { ScheduledTask } from "./task-types.js";
import type { ActiveTaskRun } from "./task-state-store.js";

const TAG = "cron-checker";
const memoryDir = (): string => join(abtarsHome(), "state");
const remindersPath = (): string => join(memoryDir(), "pending_reminders.json");

// #1502: the heartbeat evaluates schedules on every tick, so never-fires-again
// skip warnings (auto_paused / no_state) must be rate-limited per task or they
// replace one silence bug with a log flood. One warn per task per hour.
const SKIP_WARN_INTERVAL_MS = 60 * 60 * 1000;
const _skipWarnLimiter = new Map<string, number>();
function shouldWarnSkip(taskId: string): boolean {
  const now = Date.now();
  const last = _skipWarnLimiter.get(taskId) ?? 0;
  if (now - last < SKIP_WARN_INTERVAL_MS) return false;
  _skipWarnLimiter.set(taskId, now);
  return true;
}

export type ScheduleReason =
  | "active_run"
  | "due"
  | "not_due"
  | "disabled"
  | "auto_paused"
  | "no_state"
  | "completed"
  | "daily_cap"
  | "stale_advanced";

export interface ScheduleDecision {
  run: boolean;
  reason: ScheduleReason;
  detail?: string;
}

export interface PendingReminder {
  chatId: number;
  message: string;
  createdAt: number;
  threadId?: number;
}

export function readPendingReminders(): PendingReminder[] {
  if (!existsSync(remindersPath())) return [];
  try { return JSON.parse(readFileSync(remindersPath(), "utf-8")) as PendingReminder[]; }
  catch (err) { logAndSwallow(TAG, "readPendingReminders", err); return []; }
}

export function clearPendingReminders(): void {
  if (existsSync(remindersPath())) writeFileSync(remindersPath(), "[]", "utf-8");
}

export function appendReminder(r: PendingReminder): void {
  mkdirSync(memoryDir(), { recursive: true });
  const existing = readPendingReminders();
  existing.push(r);
  writeFileSync(remindersPath(), JSON.stringify(existing, null, 2), "utf-8");
}

function decideSchedule(entry: ScheduledTask): ScheduleDecision {
  if (!entry.enabled) return { run: false, reason: "disabled" };

  const state = readState(entry.id);
  if (!state) return { run: false, reason: "no_state" };
  if (state.autoPaused) {
    return { run: false, reason: "auto_paused", detail: `failures=${state.consecutiveFailures}` };
  }
  if (state.completed) return { run: false, reason: "completed" };
  if (state.activeRun) {
    return { run: false, reason: "active_run", detail: `run=${state.activeRun.runId} phase=${state.activeRun.phase}` };
  }
  if (state.nextRunAt && state.nextRunAt > Date.now()) return { run: false, reason: "not_due" };

  if (entry.maxRunsPerDay) {
    if (todaySuccessCount(entry.id, Date.now()) >= entry.maxRunsPerDay) {
      advanceNextRun(entry.id, entry.schedule);
      return { run: false, reason: "daily_cap" };
    }
  }

  // A deferred admission is a durable occurrence with its own deadline. It
  // must not be discarded by the generic missed-cron catch-up rule after a
  // restart or a prolonged heartbeat outage.
  if (!state.deferredAdmission && entry.schedule && state.nextRunAt) {
    const maxDelay = (entry.catchUpHours ?? 0) * 3600_000;
    const MIN_STALE_MS = 5 * 60_000;
    const staleThreshold = Math.max(maxDelay, MIN_STALE_MS);
    if (Date.now() - state.nextRunAt > staleThreshold) {
      advanceNextRun(entry.id, entry.schedule);
      return { run: false, reason: "stale_advanced", detail: `was ${Math.round((Date.now() - state.nextRunAt) / 60000)}min overdue` };
    }
  }

  return { run: true, reason: "due" };
}

export interface ReservedTask {
  entry: ScheduledTask;
  run: ActiveTaskRun;
}

/** Reattach a durable scheduled project to its scheduled lifecycle owner. */
export type ScheduledProjectReattach = (
  entry: ScheduledTask & { kind: "agent" },
  run: ActiveTaskRun,
) => boolean;

export function checkCron(): ReservedTask[] {
  const entries = dbReadEntries();
  const dueTasks: ReservedTask[] = [];

  // Active runs are owned by CronQueue/ScheduledTaskRunner until they publish
  // a durable terminal history event. Do not reconcile an expired deadline
  // from the heartbeat: the owner may be inside its bounded cancellation grace
  // and clearing it here creates a competing terminal claim. Restart recovery
  // is handled by reconcileActiveTaskRuns() below.
  for (const entry of entries) {
    const decision = decideSchedule(entry);
    if (decision.run) {
      const now = Date.now();
      const state = readState(entry.id);
      // #1520: a due admission deferral resumes the SAME occurrence with its
      // retained group/occurrence/deadline — a fresh run ID, never a new group.
      const deferred = state?.deferredAdmission;
      // #1502/#1520: a scheduled execution retry stays in its original run
      // group with attempt 2 — never a second fresh group.
      const retrying = state?.retrying === true && state.retryAttempt === 1;
      const reservation = reserveRun(entry.id, {
        runId: createRunId(entry.id),
        groupId: deferred?.groupId ?? (retrying ? state?.retryGroupId : undefined) ?? `${entry.id}:group:${now}`,
        attempt: retrying ? 2 : 1,
        trigger: retrying ? "retry" : "schedule",
        occurrenceAt: deferred?.occurrenceAt ?? now,
        deadlineAt: deferred?.deadlineAt ?? now + AGENT_TIMEOUT_MS,
        cardId: undefined,
      });
      if (!reservation.ok) {
        logTrace(TAG, `task_schedule_skipped task=${entry.id} reason=active_run conflict run=${reservation.active.runId}`);
        continue;
      }
      logTrace(TAG, `task_schedule_due task=${entry.id} run=${reservation.run.runId}${deferred ? ` deferred_attempt=${deferred.attempts + 1}` : ""}`);

      if (entry.kind === "reminder") {
        appendReminder({ chatId: parseInt(entry.chatId ?? "0", 10), message: entry.text, createdAt: now });
        settleRunOnce({ entry, run: reservation.run, outcome: "success" });
        logInfo(TAG, `Reminder fired: "${entry.text}"`);
      } else {
        dueTasks.push({ entry, run: reservation.run });
      }
    } else if (decision.reason === "auto_paused" || decision.reason === "no_state") {
      if (shouldWarnSkip(entry.id)) {
        const resumeCmd = decision.reason === "auto_paused" ? ` — resume: /task resume ${entry.id}` : "";
        logWarn(TAG, `Schedule skip for "${entry.id}": reason=${decision.reason}${decision.detail ? ` (${decision.detail})` : ""}${resumeCmd}`);
      } else {
        logTrace(TAG, `task_schedule_skipped task=${entry.id} reason=${decision.reason} (warn rate-limited)`);
      }
    } else {
      logTrace(TAG, `task_schedule_skipped task=${entry.id} reason=${decision.reason}`);
    }
  }

  return dueTasks;
}

const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
/** #1517: bounded grace after an owned cancellation request before fallback settlement. */
const CANCELLATION_GRACE_MS = 30_000;

/**
 * #1517: the CronQueue-owned port for live stale-run reconciliation. The
 * reconciler never guesses ownership from the task ID — only the queue knows
 * which exact run this process is executing.
 */
export interface ActiveRunSupervisor {
  owns(runId: string): boolean;
  cancel(runId: string, reason: string): "requested" | "not_owned";
}

/** Exactly-once deadline settlement shared by boot and live reconciliation. */
function settleExpiredRun(entry: ScheduledTask, run: ActiveTaskRun, detail: string, abortReason: string): void {
  settleRunOnce({
    entry, run,
    outcome: "failed",
    diagnostic: makeTaskFailure("interruption", "deadline_exceeded", "executing",
      detail, "none"),
    detail,
  });
  // #1516: terminalize the interrupted project so its Orc/Worker state
  // cannot orphan after the scheduled run is settled.
  if (run.cardId !== undefined) {
    void abortProjectById(run.cardId, abortReason);
  }
}

/**
 * #1517: live owner-aware reconciliation, run before heartbeat schedule
 * admission. Identical exactly-once primitives as boot recovery, but it must
 * never steal a terminal claim from an in-process owner: unexpired runs are
 * untouched, owned expired runs get a cancellation request and a bounded
 * grace, and only then (or immediately for unowned runs) does the fallback
 * deadline settlement win. A late executor completion cannot overwrite the
 * reconciler's terminal outcome because history is append-once.
 */
export function reconcileActiveTaskRunsLive(supervisor: ActiveRunSupervisor): void {
  const entries = dbReadEntries();
  for (const entry of entries) {
    const state = readState(entry.id);
    if (!state?.activeRun) continue;
    const run = state.activeRun;

    const terminalHistory = getRun(run.runId);
    if (terminalHistory) {
      if (settleRunFromHistory(entry, run, terminalHistory)) {
        logTrace(TAG, `task_run_reconciled task=${entry.id} run=${run.runId} action=repaired_from_history`);
      }
      continue;
    }

    if (run.deadlineAt >= Date.now()) continue;

    if (supervisor.owns(run.runId)) {
      if (run.phase === "cancelling") {
        const graceEnd = (run.lastProgressAt ?? run.reservedAt) + CANCELLATION_GRACE_MS;
        if (Date.now() >= graceEnd) {
          if (shouldWarnSkip(entry.id)) {
            logWarn(TAG, `Stale run for "${entry.id}" run=${run.runId} owned, cancellation requested — grace elapsed, settling as deadline_exceeded`);
          }
          settleExpiredRun(entry, run, "live_recovery: cancellation grace elapsed", "live_recovery: scheduled deadline passed");
        }
        continue;
      }
      const status = supervisor.cancel(run.runId, "live_recovery: deadline exceeded");
      if (status === "requested") {
        updateActiveRun(entry.id, run.runId, { phase: "cancelling", lastProgressAt: Date.now() });
        if (shouldWarnSkip(entry.id)) {
          logWarn(TAG, `Stale run for "${entry.id}" run=${run.runId} owned, deadline exceeded — cancellation requested`);
        }
      }
      continue;
    }

    if (shouldWarnSkip(entry.id)) {
      logWarn(TAG, `Stale run for "${entry.id}" run=${run.runId} unowned, deadline exceeded — fallback settlement`);
    }
    settleExpiredRun(entry, run, "live_recovery: deadline exceeded", "live_recovery: scheduled deadline passed");
  }
}

/**
 * #1520: authoritative restart recovery. Precedence:
 * 1. matching terminal history: clear stale active state only;
 * 2. durable O card + unexpired deadline: reattach its scheduled owner;
 * 3. expired run: settle once as interruption/deadline_exceeded;
 * 4. uncertain T/script/system execution that may have crossed its
 *    side-effect boundary: settle once as interruption/restart_interrupted,
 *    never replay;
 * 5. an admission deferral has no active executor and is resumed from its
 *    durable retryAt (the settler already cleared the reservation; the queue
 *    snapshot is diagnostic only and cannot create work).
 */
export function reconcileActiveTaskRuns(reattachProject?: ScheduledProjectReattach): void {
  const entries = dbReadEntries();
  for (const entry of entries) {
    const state = readState(entry.id);
    if (!state?.activeRun) continue;

    const run = state.activeRun;
    const terminalHistory = getRun(run.runId);
    if (terminalHistory) {
      // History is written before state. If the process died in that window,
      // replay the recorded policy transition instead of merely dropping the
      // reservation and leaving nextRun/retry/pause state stale.
      if (settleRunFromHistory(entry, run, terminalHistory)) {
        logTrace(TAG, `task_run_reconciled task=${entry.id} run=${run.runId} action=repaired_from_history`);
      }
      continue;
    }

    if (run.deadlineAt < Date.now()) {
      settleExpiredRun(entry, run, "restart_recovery: deadline passed", "restart_recovery: scheduled deadline passed");
      logTrace(TAG, `task_run_reconciled task=${entry.id} run=${run.runId} action=settled_deadline_passed`);
      continue;
    }

    // #1516: an interrupted scheduled project must regain its scheduled
    // lifecycle owner. The Reconciler can supervise the durable project, but
    // it cannot validate the final artifact or settle scheduled history.
    if (run.cardId !== undefined) {
      const card = kanbanGetCard(run.cardId);
      const maxAgents = entry.kind === "agent" ? (entry.orchestration?.maxAgents ?? 1) : 1;
      if (card && entry.kind === "agent" && maxAgents > 1 && reattachProject) {
        if (reattachProject(entry, run)) {
          logTrace(TAG, `task_run_reconciled task=${entry.id} run=${run.runId} action=reattached_project card=${run.cardId}`);
          continue;
        }
        logWarn(TAG, `Unable to reattach scheduled project task=${entry.id} run=${run.runId} card=${run.cardId}`);
      }
      if (card && (card.status === "done" || card.status === "delivered" || card.status === "failed")) {
        settleRunOnce({
          entry, run,
          outcome: "failed",
          diagnostic: makeTaskFailure("interruption", "restart_interrupted", "executing",
            `restart recovery: project terminal (${card.status})`, "none"),
          detail: `restart_recovery: project terminal (${card.status})`,
        });
        logTrace(TAG, `task_run_reconciled task=${entry.id} run=${run.runId} action=settled_project_terminal card=${run.cardId} status=${card.status}`);
        continue;
      }
    }

    // #1520: an uncertain T/script/system execution with no terminal history
    // is settled as interrupted — never blindly replayed, because external
    // side effects may already have occurred.
    settleRunOnce({
      entry, run,
      outcome: "failed",
      diagnostic: makeTaskFailure("interruption", "restart_interrupted", "executing",
        "restart recovery: execution interrupted, not replayed", "none"),
      detail: "restart_recovery: execution interrupted (no terminal history)",
    });
    logTrace(TAG, `task_run_reconciled task=${entry.id} run=${run.runId} action=settled_interrupted`);
  }
}
