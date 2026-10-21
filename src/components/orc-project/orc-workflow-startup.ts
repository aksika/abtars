/**
 * orc-workflow-startup.ts — #1935: startup interruption barrier.
 *
 * Every workflow admitted before this bridge generation started is interrupted
 * before completion replay, command drains, executor recovery or new admission
 * can advance it. The interrupted set is captured as a rowid watermark at
 * generation start, before any ingress phase can admit work, so peer/chat
 * admissions that arrive during boot are not swept into the old set.
 *
 * The pass is exhaustive, idempotent and crash-recoverable: each interruption
 * commits through the runner's own transition, and a crash mid-pass leaves
 * the remaining rows nonterminal for the next boot while the committed ones
 * have no executable work left. A pass that cannot make progress fails the
 * boot instead of allowing old work to resume.
 */
import type { TaskDatabase } from "../tasks/kanban-board.js";
import { WorkflowRunner, INTERRUPTED_BY_RESTART } from "./orc-workflow-runner.js";
import { WorkflowStore } from "./orc-workflow-store.js";

const BARRIER_BATCH = 100;
const TERMINAL_SQL = `('succeeded','failed','cancelled')`;

/**
 * Capture the pre-generation workflow watermark. Must run before the boot
 * graph starts any ingress path (peer API, chat platforms, heartbeat tasks).
 */
export function readWorkflowRowWatermark(db: TaskDatabase): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(rowid), 0) AS watermark FROM workflow_runs`)
    .get() as { watermark?: unknown } | undefined;
  const watermark = Number(row?.watermark ?? 0);
  if (!Number.isSafeInteger(watermark) || watermark < 0) {
    throw new Error(`workflow startup barrier: invalid workflow row watermark (${String(row?.watermark)})`);
  }
  return watermark;
}

/**
 * Fail every nonterminal workflow at or below the generation watermark.
 * Returns the number of runs interrupted by this pass (committed terminal runs
 * are not counted and never rewritten).
 */
export function failInterruptedWorkflows(db: TaskDatabase, watermark: number): number {
  if (!Number.isSafeInteger(watermark) || watermark < 0) {
    throw new Error(`workflow startup barrier: invalid watermark ${String(watermark)}`);
  }
  const store = new WorkflowStore(db);
  const runner = new WorkflowRunner(store);
  let interrupted = 0;
  for (;;) {
    const rows = db
      .prepare(
        `SELECT run_id FROM workflow_runs
          WHERE rowid <= ? AND state NOT IN ${TERMINAL_SQL}
          ORDER BY rowid LIMIT ?`,
      )
      .all(watermark, BARRIER_BATCH) as Array<{ run_id?: unknown }>;
    if (rows.length === 0) break;
    let progressed = 0;
    for (const row of rows) {
      const runId = String(row.run_id ?? "");
      if (runId.length === 0) {
        throw new Error("workflow startup barrier: workflow row without a run id");
      }
      if (runner.interruptRun(runId)) {
        interrupted++;
        progressed++;
        continue;
      }
      const live = store.getRun(runId);
      if (live && (live.state === "succeeded" || live.state === "failed" || live.state === "cancelled")) {
        continue; // settled concurrently (or already terminal) — nothing to do.
      }
      throw new Error(`workflow startup barrier: run ${runId} remained nonterminal after interruption`);
    }
    if (progressed === 0) {
      throw new Error("workflow startup barrier made no progress; refusing to start with old work live");
    }
  }
  return interrupted;
}

/** Reason carried by every interrupted workflow (workflow code stays observation_unknown). */
export const WORKFLOW_INTERRUPTION_REASON = INTERRUPTED_BY_RESTART;
