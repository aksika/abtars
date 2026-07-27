import { logAndSwallow } from "../log-and-swallow.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logInfo, logWarn, logTrace } from "../logger.js";
import { readEntries as dbReadEntries } from "./task-store.js";
import { advanceNextRun, updateState, readState, reserveRun, settleActiveRun } from "./task-state-store.js";
import { todaySuccessCount, appendRun, hasRun } from "./task-history-store.js";
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

  if (entry.schedule && state.nextRunAt) {
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

export function checkCron(): ReservedTask[] {
  const entries = dbReadEntries();
  const dueTasks: ReservedTask[] = [];

  for (const entry of entries) {
    const decision = decideSchedule(entry);
    if (decision.run) {
      const now = Date.now();
      const reservation = reserveRun(entry.id, {
        runId: `${entry.id}_${now}`,
        groupId: `${entry.id}:group:${now}`,
        attempt: 1,
        trigger: "schedule",
        occurrenceAt: now,
        deadlineAt: now + AGENT_TIMEOUT_MS,
        cardId: undefined,
      });
      if (!reservation.ok) {
        logTrace(TAG, `task_schedule_skipped task=${entry.id} reason=active_run conflict run=${reservation.active.runId}`);
        continue;
      }
      logTrace(TAG, `task_schedule_due task=${entry.id} run=${reservation.run.runId}`);

      if (entry.kind === "reminder") {
        appendReminder({ chatId: parseInt(entry.chatId ?? "0", 10), message: entry.text, createdAt: now });
        appendRun({ taskId: entry.id, kind: "reminder", trigger: "schedule", startedAt: now, finishedAt: now, outcome: "success" });
        advanceNextRun(entry.id, entry.schedule);
        settleActiveRun(entry.id, reservation.run.runId, {});
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

export function reconcileActiveTaskRuns(): void {
  const entries = dbReadEntries();
  for (const entry of entries) {
    const state = readState(entry.id);
    if (!state?.activeRun) continue;

    const run = state.activeRun;
    const hasTerminalHistory = hasRun(run.runId);
    if (hasTerminalHistory) {
      settleActiveRun(entry.id, run.runId, {});
      logTrace(TAG, `task_run_reconciled task=${entry.id} run=${run.runId} action=cleared_history_found`);
      continue;
    }

    if (run.deadlineAt < Date.now()) {
      updateState(entry.id, { lastFinishedAt: Date.now(), retrying: false, retryGroupId: undefined, retryAttempt: undefined, priorFailure: undefined, activeRun: undefined });
      appendRun({ taskId: entry.id, kind: entry.kind, trigger: run.trigger, startedAt: run.reservedAt, finishedAt: Date.now(), outcome: "cancelled", detail: "restart_recovery: deadline passed", groupId: run.groupId, runId: run.runId });
      logTrace(TAG, `task_run_reconciled task=${entry.id} run=${run.runId} action=settled_deadline_passed`);
    }
  }
}
