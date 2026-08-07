import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { logInfo } from "../logger.js";
import { CronExpressionParser } from "cron-parser";
import { randomUUID } from "node:crypto";
import type { ScheduledTask } from "./task-types.js";
import type { TaskFailureDiagnosticV1 } from "./task-failure.js";

const TAG = "task_state_store";

export type TaskRunPhase =
  | "reserved"
  | "preflight"
  | "queued"
  | "executing"
  | "cancelling"
  | "validating"
  | "settling"
  | "delivery_pending";

export interface ActiveTaskRun {
  runId: string;
  groupId: string;
  attempt: 1 | 2;
  trigger: "schedule" | "manual" | "retry";
  occurrenceAt: number;
  reservedAt: number;
  deadlineAt: number;
  phase: TaskRunPhase;
  lastProgressAt: number;
  cardId?: number;
  sessionId?: string;
  executionId?: string;
  /** #1539: monotonic meaningful-progress sequence; bounded, never per token. */
  progressSequence?: number;
  /** #1539: the first durable terminal request for this occurrence. */
  terminalRequest?: RunTerminalRequest;
}

/** #1539: durable terminal request. Cancellation recorded before a deadline
 * stays cancellation; a deadline may fill an absent request but never replaces
 * an earlier cancellation. */
export interface RunTerminalRequest {
  kind: "cancelled" | "deadline_exceeded";
  requestedAt: number;
  reason: string;
}

/** #1539: phase rank. cancelling is a terminal-request branch: nothing advances past it. */
const PHASE_RANK: Record<TaskRunPhase, number> = {
  reserved: 0,
  preflight: 1,
  queued: 2,
  executing: 3,
  cancelling: 4,
  validating: 5,
  settling: 6,
  delivery_pending: 7,
};

export interface TaskRuntimeState {
  nextRunAt: number | null;
  lastStartedAt?: number;
  lastFinishedAt?: number;
  retryAt?: number;
  retrying?: boolean;
  completed?: boolean;
  /** #1502 Task 9: durable identity for the one retry belonging to a run group. */
  retryGroupId?: string;
  retryAttempt?: 1 | 2;
  consecutiveFailures: number;
  consecutiveDeferrals: number;
  autoPaused: boolean;
  /** #1502: Failure diagnostic from the first attempt, carried to retry. */
  priorFailure?: string;
  /** #1505: Active run reservation — exclusive occurrence ownership. */
  activeRun?: ActiveTaskRun;
  /** #1520: latest structured incident; preserved across resume. */
  lastIncident?: TaskFailureDiagnosticV1;
  /** #1520: when the task auto-paused (epoch ms). */
  pausedAt?: number;
  /** #1520: bounded admission deferral for the current occurrence. */
  deferredAdmission?: DeferredAdmission;
}

/** #1520: durable bounded admission deferral — same occurrence across restarts. */
export interface DeferredAdmission {
  groupId: string;
  occurrenceAt: number;
  deadlineAt: number;
  attempts: number;
  retryAt: number;
  diagnostic: TaskFailureDiagnosticV1;
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
        consecutiveDeferrals: 0,
        autoPaused: false,
      };
      changed = true;
    }
    const existing = state[id]!;
    // #1520 Task 6: repair impossible legacy combinations. Auto-paused without
    // a pausedAt marker or a failure reason is incoherent — clear it and
    // record a synthesized incident; never silently erase a valid incident.
    if (existing.autoPaused && (existing.consecutiveFailures ?? 0) === 0) {
      logInfo(TAG, `Self-repair: clearing incoherent autoPaused for "${id}" (zero failures)`);
      existing.autoPaused = false;
      existing.pausedAt = undefined;
      if (!existing.lastIncident) {
        existing.lastIncident = { version: 1, category: "definition", code: "state_repaired", phase: "settling", message: "auto-pause cleared: incoherent legacy state (zero failures)", retryability: "permanent", occurredAt: Date.now() };
      } else {
        logInfo(TAG, `Self-repair: preserving existing incident for "${id}"`);
      }
      changed = true;
    }
    if (existing.autoPaused && existing.pausedAt === undefined) {
      existing.pausedAt = Date.now();
      logInfo(TAG, `Self-repair: backfilled pausedAt for "${id}"`);
      changed = true;
    }
    if (existing.retrying && !existing.retryGroupId) {
      logInfo(TAG, `Self-repair: clearing legacy retrying without retryGroupId for "${id}"`);
      existing.retrying = false;
      existing.retryAt = undefined;
      existing.retryAttempt = undefined;
      changed = true;
    }
    if (existing.consecutiveDeferrals === undefined) {
      existing.consecutiveDeferrals = 0;
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

  if (changed) {
    writeAll(state);
    notifyTaskDueChanged();
  }
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
    const existing = state[taskId] ?? { nextRunAt: null, consecutiveFailures: 0, consecutiveDeferrals: 0, autoPaused: false };
    state[taskId] = { ...existing, ...update };
    return state;
  });
  notifyTaskDueChanged();
}

/** Apply a state patch only while the caller's durable predicate still holds. */
export function updateStateIf(
  taskId: string,
  predicate: (state: TaskRuntimeState) => boolean,
  update: Partial<TaskRuntimeState>,
): boolean {
  let changed = false;
  writeAtomic(state => {
    const existing = state[taskId];
    if (!existing || !predicate(existing)) return state;
    state[taskId] = { ...existing, ...update };
    changed = true;
    return state;
  });
  if (changed) notifyTaskDueChanged();
  return changed;
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
}/** #1520: pure next-run computation for the atomic settler patch. */
export function nextRunFromSchedule(task: Pick<ScheduledTask, "schedule">): { nextRunAt?: number; completed?: boolean } {
  if (!task.schedule) return { completed: true };
  try {
    return { nextRunAt: CronExpressionParser.parse(task.schedule).next().getTime() };
  } catch {
    return {};
  }
}

export function incrementFailures(taskId: string): number {
  let count = 0;
  writeAtomic(state => {
    const existing = state[taskId] ?? { nextRunAt: null, consecutiveFailures: 0, consecutiveDeferrals: 0, autoPaused: false };
    count = (existing.consecutiveFailures ?? 0) + 1;
    state[taskId] = { ...existing, consecutiveFailures: count };
    return state;
  });
  return count;
}

export function resetFailures(taskId: string): void {
  writeAtomic(state => {
    if (state[taskId]) {
      state[taskId].consecutiveFailures = 0;
      state[taskId].consecutiveDeferrals = 0;
    }
    return state;
  });
}

export function incrementDeferrals(taskId: string): number {
  let count = 0;
  writeAtomic(state => {
    const existing = state[taskId] ?? { nextRunAt: null, consecutiveFailures: 0, consecutiveDeferrals: 0, autoPaused: false };
    count = (existing.consecutiveDeferrals ?? 0) + 1;
    state[taskId] = { ...existing, consecutiveDeferrals: count };
    return state;
  });
  return count;
}

export function resetDeferrals(taskId: string): void {
  writeAtomic(state => {
    if (state[taskId]) state[taskId].consecutiveDeferrals = 0;
    return state;
  });
}

export function setAutoPaused(taskId: string, paused: boolean): void {
  writeAtomic(state => {
    if (state[taskId]) {
      state[taskId].autoPaused = paused;
      state[taskId].pausedAt = paused ? (state[taskId].pausedAt ?? Date.now()) : undefined;
    }
    return state;
  });
  notifyTaskDueChanged();
}

export function removeState(taskId: string): void {
  writeAtomic(state => {
    delete state[taskId];
    return state;
  });
  notifyTaskDueChanged();
}

export function setRetrying(taskId: string, retrying: boolean, retryAt?: number): void {
  writeAtomic(state => {
    if (state[taskId]) {
      state[taskId].retrying = retrying;
      if (retryAt !== undefined) state[taskId].retryAt = retryAt;
    }
    return state;
  });
  notifyTaskDueChanged();
}

export type ReserveRunResult =
  | { ok: true; run: ActiveTaskRun }
  | { ok: false; active: ActiveTaskRun };

/** Run IDs must remain unique even when two occurrences are reserved in one millisecond. */
export function createRunId(taskId: string): string {
  return `${taskId}_${randomUUID().slice(0, 12)}`;
}

export function reserveRun(taskId: string, candidate: Omit<ActiveTaskRun, "reservedAt" | "phase" | "lastProgressAt">): ReserveRunResult {
  let result: ReserveRunResult = { ok: false, active: undefined! };
  writeAtomic(state => {
    const existing = state[taskId];
    if (existing?.activeRun) {
      result = { ok: false, active: existing.activeRun };
      return state;
    }
    const run: ActiveTaskRun = {
      ...candidate,
      reservedAt: Date.now(),
      phase: "reserved",
      lastProgressAt: Date.now(),
    };
    state[taskId] = {
      ...(existing ?? { nextRunAt: null, consecutiveFailures: 0, consecutiveDeferrals: 0, autoPaused: false }),
      activeRun: run,
      lastStartedAt: Date.now(),
    };
    result = { ok: true, run };
    return state;
  });
  notifyTaskDueChanged();
  return result;
}

export function updateActiveRun(taskId: string, runId: string, patch: Partial<ActiveTaskRun>): boolean {
  let found = false;
  writeAtomic(state => {
    const existing = state[taskId];
    if (!existing?.activeRun || existing.activeRun.runId !== runId) return state;
    state[taskId] = { ...existing, activeRun: { ...existing.activeRun, ...patch } };
    found = true;
    return state;
  });
  return found;
}

export type AdvanceRunResult = "advanced" | "stale" | "regression";

/**
 * #1539: one atomic monotonic progress write. Validates phase rank (a run
 * never moves to an earlier phase, and nothing advances past `cancelling`),
 * advances `lastProgressAt` only forward, increments `progressSequence` only
 * for a meaningful progress write, and merges bounded attachments.
 *
 * #1600: deliberately does NOT call `notifyTaskDueChanged()`. The run-deadline
 * due source is level-triggered — `wakeDue` re-reads durable state and
 * re-validates both limits before settling — so a timer armed against a
 * now-stale earlier idle instant fires, finds nothing expired, settles
 * nothing, and `armEarliest()` immediately re-arms against the recomputed
 * later instant. Adding the notify here would be write amplification on the
 * hot progress path for zero correctness gain.
 */
export function advanceRun(
  taskId: string,
  runId: string,
  update: { phase?: TaskRunPhase; progressAt?: number; attachments?: { cardId?: number; sessionId?: string; executionId?: string } },
): AdvanceRunResult {
  let result: AdvanceRunResult = "stale";
  writeAtomic(state => {
    const existing = state[taskId];
    if (!existing?.activeRun || existing.activeRun.runId !== runId) return state;
    const run = existing.activeRun;
    if (update.phase !== undefined && update.phase !== run.phase) {
      const newRank = PHASE_RANK[update.phase] ?? -1;
      const oldRank = PHASE_RANK[run.phase] ?? -1;
      if (run.phase === "cancelling" || newRank < oldRank) {
        result = "regression";
        return state;
      }
    }
    const activeRun: ActiveTaskRun = { ...run };
    if (update.phase !== undefined) activeRun.phase = update.phase;
    if (update.progressAt !== undefined) {
      const progressAt = Math.max(0, update.progressAt);
      if (progressAt > activeRun.lastProgressAt) {
        activeRun.lastProgressAt = progressAt;
        activeRun.progressSequence = (activeRun.progressSequence ?? 0) + 1;
      }
    }
    if (update.attachments) {
      if (update.attachments.cardId !== undefined) activeRun.cardId = update.attachments.cardId;
      if (update.attachments.sessionId !== undefined) activeRun.sessionId = update.attachments.sessionId;
      if (update.attachments.executionId !== undefined) activeRun.executionId = update.attachments.executionId;
    }
    state[taskId] = { ...existing, activeRun };
    result = "advanced";
    return state;
  });
  return result;
}

export type TerminalRequestResult = "requested" | "already_requested" | "stale";

/**
 * #1539: record the first durable terminal request. Cancellation always wins
 * over a later deadline; a deadline fills an absent request but never replaces
 * an earlier cancellation. Moving to `cancelling` is part of the request so no
 * code path can write the branch phase without the durable request.
 */
export function requestRunTerminal(
  taskId: string,
  runId: string,
  request: RunTerminalRequest,
): TerminalRequestResult {
  let result: TerminalRequestResult = "stale";
  writeAtomic(state => {
    const existing = state[taskId];
    if (!existing?.activeRun || existing.activeRun.runId !== runId) return state;
    const run = existing.activeRun;
    const current = run.terminalRequest;
    if (current) {
      if (current.kind === "cancelled") {
        result = "already_requested";
        return state;
      }
      if (request.kind === "cancelled") {
        state[taskId] = { ...existing, activeRun: { ...run, terminalRequest: request, phase: "cancelling" } };
        result = "requested";
        return state;
      }
      result = "already_requested";
      return state;
    }
    state[taskId] = { ...existing, activeRun: { ...run, terminalRequest: request, phase: "cancelling" } };
    result = "requested";
    return state;
  });
  notifyTaskDueChanged();
  return result;
}

/** #1539: hook notified after any durable task-state mutation that can change
 * admission/retry/deadline due times. Wired to the lifecycle wake scheduler. */
let taskDueChangedHook: (() => void) | null = null;
export function setTaskDueChangedHook(hook: (() => void) | null): void {
  taskDueChangedHook = hook;
}
export function notifyTaskDueChanged(): void {
  try {
    taskDueChangedHook?.();
  } catch (err) {
    logAndSwallow(TAG, "notifyTaskDueChanged", err);
  }
}

export function settleActiveRun(taskId: string, runId: string, statePatch: Partial<TaskRuntimeState>): boolean {
  let found = false;
  writeAtomic(state => {
    const existing = state[taskId];
    if (!existing?.activeRun || existing.activeRun.runId !== runId) return state;
    state[taskId] = {
      ...existing,
      ...statePatch,
      activeRun: undefined,
    };
    found = true;
    return state;
  });
  if (found) notifyTaskDueChanged();
  return found;
}
