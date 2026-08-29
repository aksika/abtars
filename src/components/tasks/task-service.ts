import type { ScheduledTask } from "./task-types.js";
import type { TaskRuntimeState } from "./task-state-store.js";
import type { TaskRunEvent } from "./task-history-store.js";
import type { TaskFailureDiagnosticV1 } from "./task-failure.js";
import { AUTO_RESUME_COOLDOWN_MS, MAX_AUTO_RESUMES_PER_EPISODE } from "./task-failure.js";
import * as stateStore from "./task-state-store.js";
import * as historyStore from "./task-history-store.js";
import { readEntry, writeEntry, TaskCatalogUnavailableError } from "./task-store.js";
import { logAndSwallow } from "../log-and-swallow.js";


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
    nextRunAt: null, consecutiveFailures: 0, consecutiveDeferrals: 0, autoPaused: false, autoResumeCount: 0,
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
  try {
    const entry = readEntry(taskId);
    if (!entry) return;
    const updated: ScheduledTask = { ...entry, enabled } as ScheduledTask;
    writeEntry(updated);
  } catch (err) {
    if (err instanceof TaskCatalogUnavailableError) return;
    logAndSwallow("task_service", "setEnabled", err);
  }
}

export type ResumeResult = "resumed" | "already_running" | "not_paused" | "invalid" | "not_found";

export type PauseResult = "paused" | "not_found";

/**
 * #1609: one explicit-pause operation for chat, CLI, and dashboard. Always
 * refreshes `pausedAt` to now — re-pausing an already-paused task starts a
 * fresh 12-hour cooldown, exactly like the auto-pause path.
 */
export function pauseTask(taskId: string, tasks: ScheduledTask[]): PauseResult {
  const entry = tasks.find(t => t.id === taskId);
  if (!entry) return "not_found";
  stateStore.setAutoPaused(taskId, true);
  return "paused";
}

/**
 * #1609: the shared cleanup + future-schedule patch used by BOTH manual and
 * automatic resume. Clears pause/failure/retry/deferral state and computes the
 * next future occurrence exactly as the old manual resume did. It never
 * executes and never touches `autoResumeCount`; automatic resume increments it
 * through its own conditional store transition.
 */
function resumePatch(entry: ScheduledTask): Partial<TaskRuntimeState> {
  const next = stateStore.nextRunFromSchedule(entry);
  return {
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
}

/**
 * #1520/#1609: one atomic manual resume operation — the operator escape hatch
 * that never counts toward the automatic-resume episode cap. In one state
 * write it clears the pause, failure/deferral counters, retry and
 * active-admission metadata, preserves the incident, and computes the next
 * cron occurrence (never in the past). It never executes and never re-enables
 * a disabled definition.
 */
export function resumeAutoPaused(taskId: string, tasks: ScheduledTask[]): ResumeResult {
  const entry = tasks.find(t => t.id === taskId);
  if (!entry) return "not_found";
  const state = stateStore.readState(taskId);
  if (!state) return "not_found";
  if (!state.autoPaused) return "not_paused";
  if (state.activeRun) return "already_running";

  if (stateStore.updateStateIf(taskId, current => current.autoPaused === true && !current.activeRun, resumePatch(entry))) return "resumed";
  const current = stateStore.readState(taskId);
  if (current?.activeRun) return "already_running";
  if (!current?.autoPaused) return "not_paused";
  return "not_found";
}

export type AutoResumeResult = "resumed" | "cooling_down" | "cap_exhausted" | "already_running" | "not_paused" | "not_found";

/**
 * #1609: the checker's one conditional cooldown/resume transition. Eligible
 * only when the task is still paused, has no active run, its observed pause
 * timestamp is unchanged, the 12-hour cooldown has expired, and the episode
 * count is below the cap. The store's conditional SQL is the race guard; the
 * caller's eligibility read only picks the typed label. A resumed task is
 * scheduled for its next FUTURE occurrence and is never executed here.
 */
export function autoResumeIfDue(taskId: string, tasks: ScheduledTask[], now = Date.now()): AutoResumeResult {
  const entry = tasks.find(t => t.id === taskId);
  if (!entry) return "not_found";
  const state = stateStore.readState(taskId);
  if (!state || !state.autoPaused) return "not_paused";
  if (state.activeRun) return "already_running";
  const pausedAt = state.pausedAt ?? now;
  if (now < pausedAt + AUTO_RESUME_COOLDOWN_MS) return "cooling_down";
  if ((state.autoResumeCount ?? 0) >= MAX_AUTO_RESUMES_PER_EPISODE) return "cap_exhausted";

  const next = stateStore.nextRunFromSchedule(entry);
  const won = stateStore.claimAutoResume(taskId, {
    pausedAt,
    nextRunAt: next.nextRunAt ?? null,
    completed: next.completed === true,
    maxResumes: MAX_AUTO_RESUMES_PER_EPISODE,
  });
  if (won) return "resumed";

  // A lost CAS is a concurrent transition (manual resume, re-pause, active
  // run, or cap increment). Re-read to label the loser truthfully.
  const current = stateStore.readState(taskId);
  if (!current || !current.autoPaused) return "not_paused";
  if (current.activeRun) return "already_running";
  if (current.pausedAt !== pausedAt) return "cooling_down";
  if ((current.autoResumeCount ?? 0) >= MAX_AUTO_RESUMES_PER_EPISODE) return "cap_exhausted";
  return "cooling_down";
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


