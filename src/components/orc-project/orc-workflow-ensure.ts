/**
 * orc-workflow-ensure.ts — #1792: on-demand schema readiness for runner paths
 * that touch tables owned by other stores (worker attempts, retry budgets,
 * lease snapshots, input requests).
 *
 * Production boot migrates these long before any supervised activity, making
 * every call below a fast no-op. The guarantee matters for paths reachable
 * without prior worker activity (cancellation, inspection, input): without
 * it a missing table turns a routine cancel into a failed commit. All four
 * constructors only assign the handle and run idempotent DDL — no timers,
 * no subscriptions, no nerve traffic.
 *
 * Deliberately a LEAF module (imports stores only): worker-supervision-store
 * imports the settlement hook, so this must not live behind that edge.
 */
import { WorkerSupervisionStore } from "../worker-supervision-store.js";
import { ExecutorLeaseStore } from "../executor-lease-store.js";
import { RetryStore } from "../retry/retry-store.js";
import { ProjectReviewStore } from "../project-acceptance/project-review-store.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";

export function ensureRunnerTables(db: TaskDatabase): void {
  new WorkerSupervisionStore(db);
  new ExecutorLeaseStore(db);
  new RetryStore(db);
  new ProjectReviewStore(db);
}
