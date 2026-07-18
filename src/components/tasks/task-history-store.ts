import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { abtarsHome } from "../../paths.js";
import { logAndSwallow } from "../log-and-swallow.js";
import type { TaskKind } from "./task-types.js";

const TAG = "task_history_store";

export type TaskOutcome = "success" | "failed" | "noop" | "deferred" | "skipped" | "cancelled";

export interface TaskRunEvent {
  runId: string;
  taskId: string;
  kind: TaskKind;
  trigger: "schedule" | "manual" | "retry";
  startedAt: number;
  finishedAt: number;
  outcome: TaskOutcome;
  exitCode?: number;
  detail?: string;
  resultPath?: string;
  kanbanCardId?: number;
}

function historyPath(): string {
  return join(abtarsHome(), "tasks", "task-history.jsonl");
}

function ensureDir(): void {
  mkdirSync(dirname(historyPath()), { recursive: true });
}

export function appendRun(event: Omit<TaskRunEvent, "runId">): string {
  const runId = randomUUID().slice(0, 12);
  const full: TaskRunEvent = { ...event, runId };
  ensureDir();
  try {
    appendFileSync(historyPath(), JSON.stringify(full) + "\n", "utf-8");
  } catch (err) {
    logAndSwallow(TAG, "appendRun", err);
  }
  return runId;
}

function readAllLines(): string[] {
  const p = historyPath();
  if (!existsSync(p)) return [];
  try {
    const content = readFileSync(p, "utf-8");
    const lines = content.split("\n");
    // tolerate truncated final line
    if (lines.length > 0 && lines[lines.length - 1] !== "" && !lines[lines.length - 1]!.endsWith("}")) {
      lines.pop();
    }
    return lines.filter(l => l.trim().length > 0);
  } catch (err) {
    logAndSwallow(TAG, "readAllLines", err);
    return [];
  }
}

function parseEvents(lines: string[]): TaskRunEvent[] {
  const events: TaskRunEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as TaskRunEvent);
    } catch {
      // skip malformed
    }
  }
  return events;
}

export function recentRuns(taskId: string, limit: number = 10): TaskRunEvent[] {
  const lines = readAllLines();
  const events = parseEvents(lines);
  return events
    .filter(e => e.taskId === taskId)
    .reverse()
    .slice(0, limit);
}

export function todaySuccessCount(taskId: string, now: number = Date.now()): number {
  const todayStart = new Date(now).setHours(0, 0, 0, 0);
  const lines = readAllLines();
  const events = parseEvents(lines);
  return events.filter(e =>
    e.taskId === taskId &&
    e.outcome === "success" &&
    e.finishedAt >= todayStart
  ).length;
}

export function latestOutcomeByTask(_now: number = Date.now()): Map<string, TaskRunEvent> {
  const lines = readAllLines();
  const events = parseEvents(lines);
  const latest = new Map<string, TaskRunEvent>();
  for (const e of events) {
    const existing = latest.get(e.taskId);
    if (!existing || e.finishedAt > existing.finishedAt) {
      latest.set(e.taskId, e);
    }
  }
  return latest;
}
