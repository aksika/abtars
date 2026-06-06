/**
 * task-failure-buffer.ts — Buffers task failure notifications for injection (#646).
 * Drained before each prompt in the message pipeline.
 */

export interface TaskFailureEntry {
  taskName: string;
  exitCode: number;
  error?: string;
  timestamp: number;
  consecutiveFailures: number;
}

const buffer: TaskFailureEntry[] = [];

export function addTaskFailure(entry: TaskFailureEntry): void {
  buffer.push(entry);
}

/** Drain all pending failures (consumed once on next prompt). */
export function drainTaskFailures(): TaskFailureEntry[] {
  const entries = buffer.splice(0);
  return entries;
}

export function hasTaskFailures(): boolean {
  return buffer.length > 0;
}
