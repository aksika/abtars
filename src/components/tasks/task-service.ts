import type { ScheduledTask } from "./task-types.js";
import type { TaskRuntimeState } from "./task-state-store.js";
import type { TaskRunEvent } from "./task-history-store.js";
import * as stateStore from "./task-state-store.js";
import * as historyStore from "./task-history-store.js";


export interface TaskView {
  definition: ScheduledTask;
  state: TaskRuntimeState;
  latestRuns: TaskRunEvent[];
  running: boolean;
}

export function getTaskView(task: ScheduledTask, runningTaskIds: Set<string> = new Set()): TaskView {
  const s = stateStore.readState(task.id) ?? {
    nextRunAt: null, consecutiveFailures: 0, autoPaused: false,
  };
  const runs = historyStore.recentRuns(task.id, 5);
  return {
    definition: task,
    state: s,
    latestRuns: runs,
    running: runningTaskIds.has(task.id),
  };
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

export function resumeAutoPaused(taskId: string): void {
  stateStore.setAutoPaused(taskId, false);
  stateStore.resetFailures(taskId);
}

export function triggerNow(taskId: string, tasks: ScheduledTask[]): boolean {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return false;
  const now = Date.now();
  stateStore.updateState(taskId, { nextRunAt: now - 1000 });
  stateStore.setAutoPaused(taskId, false);
  return true;
}

export function removeTask(taskId: string, tasks: ScheduledTask[]): boolean {
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  stateStore.removeState(taskId);
  return true;
}
