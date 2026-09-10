/**
 * orc-workflow-settlement.ts — #1792 Task 5: worker-settlement joint commit.
 *
 * Called from inside the worker settlement transaction (settleAttemptInTransaction):
 * the worker result and the runner successor obligation share ONE transaction.
 * Unmapped attempts (unsupervised, legacy-supervised) return silently with zero
 * behavior change. Hook failures are contained by savepoint and logged: the
 * settlement must persist even if the runner mapping is stale (recovery via
 * recoverUnconsumedCompletions + audit redrive).
 *
 * Retry safety comes from the same pure classifier the retry service uses
 * (retry/failure-classifier.js — a leaf module, no import cycle):
 * retryability "automatic" → runner work-retry allowance applies; anything
 * else (or absent classification) → no blind retry, terminal evaluation
 * decides (repair cycles and operator-gated retries remain available).
 */
import { createHash } from "node:crypto";
import { classify } from "../retry/failure-classifier.js";
import type { WorkerResultEnvelopeV1 } from "../worker-contract.js";
import { logWarn } from "../logger.js";
import { requireTaskDatabase } from "../tasks/kanban-board.js";
import { boundText } from "./orc-workflow-runner.js";
import { workflowStoreFor } from "./orc-workflow-store.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";
import { WorkflowRunner } from "./orc-workflow-runner.js";

export interface SettledAttempt {
  attemptId: string;
  cardId: number;
  rootCardId: number | null;
  lifecycle: "completed" | "failed" | "cancelled" | "timed_out";
  generation: number;
  stableReason: string;
  envelopeJson: string | null;
}

const runners = new WeakMap<object, WorkflowRunner>();

function runnerForDb(db: TaskDatabase): WorkflowRunner {
  let runner = runners.get(db);
  if (!runner) {
    runner = new WorkflowRunner(workflowStoreFor(db));
    runners.set(db, runner);
  }
  return runner;
}

/**
 * Whether a worker card is bound to a live workflow run's node (reconciler
 * retry inference stands down; false on any read failure — safe direction
 * keeps legacy handling rather than dropping retries).
 */
export function isRunnerManagedCard(cardId: number): boolean {
  return workflowStoreFor(requireTaskDatabase()).isCardRunnerManaged(cardId);
}

function classifyRetrySafe(
  db: TaskDatabase,
  input: { attemptId: string; lifecycle: string; envelopeJson: string | null },
): boolean {
  try {
    // Prefer a stored classification (recorded by reduceTerminalAttempt on
    // re-runs); otherwise classify fresh with the same pure classifier.
    // Absent/unparseable either way → false: never blind-retry.
    try {
      const stored = db
        .prepare(`SELECT classification_json FROM attempt_failure_classifications WHERE attempt_id = ?`)
        .get(input.attemptId) as { classification_json: string } | undefined;
      if (stored) {
        const parsed = JSON.parse(stored.classification_json) as { retryability?: string };
        if (typeof parsed.retryability === "string") return parsed.retryability === "automatic";
      }
    } catch {
      // Missing table (minimal harness) or bad row: fall through to fresh.
    }
    let envelope: Record<string, unknown> | undefined;
    if (input.envelopeJson) {
      envelope = JSON.parse(input.envelopeJson) as Record<string, unknown>;
    }
    const { classification } = classify({
      attempt_id: input.attemptId,
      envelope: envelope as unknown as WorkerResultEnvelopeV1 | undefined,
      lifecycle: input.lifecycle,
    });
    return classification.retryability === "automatic";
  } catch {
    return false;
  }
}

/**
 * Commit the supervised successor obligation in the CALLER's transaction
 * (settlement joint commit). Never throws: containment + logging protect the
 * settlement result.
 */
export function commitSupervisedOutcome(db: TaskDatabase, attempt: SettledAttempt): void {
  try {
    if (attempt.rootCardId == null) return;
    const store = workflowStoreFor(db);
    const run = store.findRunByCard(attempt.rootCardId);
    if (!run) return; // legacy/unsupervised root: existing behavior unchanged.
    if (run.state === "succeeded" || run.state === "failed" || run.state === "cancelled") return;
    const node = store.findNodeByCard(run.runId, attempt.cardId);
    if (!node) return; // attempt not runner-dispatched.
    const runner = runnerForDb(db);
    const eventId = `attempt-${attempt.attemptId}-${attempt.lifecycle}`;
    if (attempt.lifecycle === "completed") {
      const payloadJson = JSON.stringify({
        kind: "AttemptSucceeded",
        body: { nodeId: node.nodeId, attemptId: attempt.attemptId, artifactsJson: attempt.envelopeJson ?? "{}" },
      });
      runner.commitStoredAttemptOutcome({
        runId: run.runId, kind: "AttemptSucceeded",
        body: { nodeId: node.nodeId, attemptId: attempt.attemptId, artifactsJson: attempt.envelopeJson ?? "{}" },
        revision: node.revision,
        event: {
          eventId, runId: run.runId,
          payloadHash: createHash("sha256").update(payloadJson).digest("hex"),
          payloadJson, generation: run.generation, stateVersion: run.stateVersion,
        },
      });
      return;
    }
    const retrySafe = classifyRetrySafe(db, {
      attemptId: attempt.attemptId, lifecycle: attempt.lifecycle, envelopeJson: attempt.envelopeJson,
    });
    const cause = `${attempt.lifecycle}: ${attempt.stableReason}`;
    const payloadJson = JSON.stringify({
      kind: "AttemptFailed",
      body: { nodeId: node.nodeId, attemptId: attempt.attemptId, cause, retrySafe },
    });
    runner.commitStoredAttemptOutcome({
      runId: run.runId, kind: "AttemptFailed",
      body: { nodeId: node.nodeId, attemptId: attempt.attemptId, cause, retrySafe },
      revision: node.revision,
      event: {
        eventId, runId: run.runId,
        payloadHash: createHash("sha256").update(payloadJson).digest("hex"),
        payloadJson, generation: run.generation, stateVersion: run.stateVersion,
      },
    });
  } catch (err) {
    logWarn("workflow-settlement", `supervised successor contained: ${boundText(err instanceof Error ? err.message : String(err), 300)}`);
  }
}
