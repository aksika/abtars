import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { logInfo } from "../logger.js";
import { CronExpressionParser } from "cron-parser";
import type { ScheduledTask } from "./task-types.js";

const TAG = "task_state_store";

export interface TaskRuntimeState {
  nextRunAt: number | null;
  lastStartedAt?: number;
  lastFinishedAt?: number;
  retryAt?: number;
  retrying?: boolean;
  completed?: boolean;
  consecutiveFailures: number;
  autoPaused: boolean;
}

type TaskStateFile = Record<string, TaskRuntimeState>;

function statePath(): string {
  return join(abtarsHome(), "tasks", "task-state.json");
}

function readAll(): TaskStateFile {
  const p = statePath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as TaskStateFile;
  } catch (err) {
    logAndSwallow(TAG, "read state", err);
    return {};
  }
}

function writeAll(state: TaskStateFile): void {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, p);
}

function writeAtomic(update: (state: TaskStateFile) => TaskStateFile): void {
  const state = readAll();
  const updated = update(state);
  writeAll(updated);
}

export function readState(taskId: string): TaskRuntimeState | null {
  return readAll()[taskId] ?? null;
}

export function initializeState(entries: ScheduledTask[]): void {
  const state = readAll();
  const validIds = new Set(entries.map(e => e.id));
  let changed = false;

  for (const id of validIds) {
    if (!state[id]) {
      state[id] = {
        nextRunAt: deriveNextRun(entries.find(e => e.id === id)!),
        consecutiveFailures: 0,
        autoPaused: false,
      };
      changed = true;
    }
  }

  for (const id of Object.keys(state)) {
    if (!validIds.has(id)) {
      logInfo(TAG, `Removed orphan state for "${id}"`);
      delete state[id];
      changed = true;
    }
  }

  if (changed) writeAll(state);
}

function deriveNextRun(task: ScheduledTask): number | null {
  if (task.schedule) {
    try {
      return CronExpressionParser.parse(task.schedule).next().getTime();
    } catch {
      if (task.at) return Date.parse(task.at);
      return null;
    }
  }
  if (task.at) return Date.parse(task.at);
  return null;
}

export function updateState(taskId: string, update: Partial<TaskRuntimeState>): void {
  writeAtomic(state => {
    const existing = state[taskId] ?? { nextRunAt: null, consecutiveFailures: 0, autoPaused: false };
    state[taskId] = { ...existing, ...update };
    return state;
  });
}

export function advanceNextRun(taskId: string, schedule?: string): boolean {
  if (!schedule) {
    updateState(taskId, { completed: true });
    return true;
  }
  try {
    const next = CronExpressionParser.parse(schedule).next().getTime();
    updateState(taskId, { nextRunAt: next, completed: undefined });
    return true;
  } catch {
    return false;
  }
}

export function incrementFailures(taskId: string): number {
  let count = 0;
  writeAtomic(state => {
    const existing = state[taskId] ?? { nextRunAt: null, consecutiveFailures: 0, autoPaused: false };
    count = (existing.consecutiveFailures ?? 0) + 1;
    state[taskId] = { ...existing, consecutiveFailures: count };
    return state;
  });
  return count;
}

export function resetFailures(taskId: string): void {
  writeAtomic(state => {
    if (state[taskId]) state[taskId].consecutiveFailures = 0;
    return state;
  });
}

export function setAutoPaused(taskId: string, paused: boolean): void {
  writeAtomic(state => {
    if (state[taskId]) state[taskId].autoPaused = paused;
    return state;
  });
}

export function removeState(taskId: string): void {
  writeAtomic(state => {
    delete state[taskId];
    return state;
  });
}

export function setRetrying(taskId: string, retrying: boolean, retryAt?: number): void {
  writeAtomic(state => {
    if (state[taskId]) {
      state[taskId].retrying = retrying;
      if (retryAt !== undefined) state[taskId].retryAt = retryAt;
    }
    return state;
  });
}
