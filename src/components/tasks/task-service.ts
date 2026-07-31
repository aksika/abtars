import type { ScheduledTask } from "./task-types.js";
import type { TaskRuntimeState } from "./task-state-store.js";
import type { TaskRunEvent } from "./task-history-store.js";
import type { TaskFailureDiagnosticV1 } from "./task-failure.js";
import * as stateStore from "./task-state-store.js";
import * as historyStore from "./task-history-store.js";


export interface TaskView {
  definition: ScheduledTask;
  state: TaskRuntimeState;
  latestRuns: TaskRunEvent[];
  running: boolean;
  /** #1520: structured incident, pause time, and exact resume command. */
  lastIncident?: TaskFailureDiagnosticV1;
  pausedAt?: number;
  resumeCommand?: string;
}

export function getTaskView(task: ScheduledTask, runningTaskIds: Set<string> = new Set()): TaskView {
  const s = stateStore.readState(task.id) ?? {
    nextRunAt: null, consecutiveFailures: 0, consecutiveDeferrals: 0, autoPaused: false,
  };
  const runs = historyStore.recentRuns(task.id, 5);
  const view: TaskView = {
    definition: task,
    state: s,
    latestRuns: runs,
    running: runningTaskIds.has(task.id),
    lastIncident: s.lastIncident,
    pausedAt: s.pausedAt,
  };
  if (s.autoPaused) {
    view.resumeCommand = `/task resume ${task.id}`;
  }
  return view;
}

export function getAllViews(tasks: ScheduledTask[], runningTaskIds: Set<string> = new Set()): TaskView[] {
  return tasks.map(t => getTaskView(t, runningTaskIds));
}

export function setEnabled(taskId: string, enabled: boolean): void {
  const { readEntries, writeEntries } = require("./task-store.js");
  const entries = readEntries();
  const idx = entries.findIndex((e: ScheduledTask) => e.id === taskId);
  if (idx === -1) return;
  entries[idx] = { ...entries[idx], enabled } as ScheduledTask;
  writeEntries(entries);
}

export type ResumeResult = "resumed" | "already_running" | "not_paused" | "invalid" | "not_found";

/**
 * #1520: one atomic resume operation. In one state write it clears the pause,
 * failure/deferral counters, retry and active-admission metadata, preserves
 * the incident, and computes the next cron occurrence (never in the past).
 * It never executes and never re-enables a disabled definition.
 */
export function resumeAutoPaused(taskId: string, tasks: ScheduledTask[]): ResumeResult {
  const entry = tasks.find(t => t.id === taskId);
  if (!entry) return "not_found";
  const state = stateStore.readState(taskId);
  if (!state) return "not_found";
  if (!state.autoPaused) return "not_paused";
  if (state.activeRun) return "already_running";

  const next = stateStore.nextRunFromSchedule(entry);
  const patch: Partial<TaskRuntimeState> = {
    autoPaused: false,
    pausedAt: undefined,
    consecutiveFailures: 0,
    consecutiveDeferrals: 0,
    retrying: false,
    retryAt: undefined,
    retryGroupId: undefined,
    retryAttempt: undefined,
    priorFailure: undefined,
    deferredAdmission: undefined,
    ...(next.nextRunAt !== undefined ? { nextRunAt: next.nextRunAt } : {}),
    ...(next.completed === true ? { completed: true } : {}),
  };
  if (stateStore.updateStateIf(taskId, current => current.autoPaused === true && !current.activeRun, patch)) return "resumed";
  const current = stateStore.readState(taskId);
  if (current?.activeRun) return "already_running";
  if (!current?.autoPaused) return "not_paused";
  return "not_found";
}

export function triggerNow(taskId: string, tasks: ScheduledTask[]): boolean {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return false;
  const now = Date.now();
  stateStore.updateState(taskId, { nextRunAt: now - 1000 });
  stateStore.setAutoPaused(taskId, false);
  stateStore.resetFailures(taskId);
  return true;
}

export function removeTask(taskId: string, tasks: ScheduledTask[]): boolean {
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  stateStore.removeState(taskId);
  return true;
}
