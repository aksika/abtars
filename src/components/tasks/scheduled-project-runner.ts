/**
 * scheduled-project-runner.ts — #1516: supervised-project execution for
 * scheduled agent tasks with `orchestration.maxAgents > 1`.
 *
 * Bridges the scheduled lifecycle (preflight, absolute deadline, report
 * validation, exactly-once settlement, retry, delivery — all owned by
 * ScheduledTaskRunner) to the durable Orc project lifecycle: one root O card
 * carrying the durable agent cap, contract authoring through the Orc
 * coordinator, supervised Workers bounded by the cap, and acceptance observed
 * through the project supervision store.
 */

import { nerve } from "../nerve.js";
import { logInfo } from "../logger.js";
import { kanbanEnqueue, kanbanRunning, kanbanGetCard } from "./kanban-board.js";
import { readState, updateActiveRun } from "./task-state-store.js";
import { ProjectReviewStore } from "../project-acceptance/project-review-store.js";
import { abortProjectById, getOrCreateOrcCoordinator } from "../reconciler.js";
import type { ExecutionControl } from "../execution-control.js";
import type { ToolExecutionScope } from "./task-package.js";
import type { Delivery } from "./task-types.js";

const TAG = "scheduled-project-runner";
const RECHECK_INTERVAL_MS = 10_000;

export interface ScheduledProjectRequest {
  entryId: string;
  runId: string;
  title: string;
  goal: string;
  priority: "high" | "medium" | "low";
  maxAgents: number;
  deadlineAt: number;
  executionScope: ToolExecutionScope;
  executionControl: ExecutionControl;
  delivery: Delivery;
  chatId?: string;
  /** #1516: the single-writer final report artifact, owned by the Orc. */
  reportArtifactPath?: string;
}

export type ScheduledProjectRunner = (
  request: ScheduledProjectRequest,
) => Promise<{ cardId: number; result: string }>;

/**
 * #1516: Admit a scheduled agent task as a supervised Orc project.
 *
 * Admission is synchronous until the contract-authoring claim is durable, so
 * the goal-bearing claim always races ahead of the Reconciler's generic
 * authoring wake for the same card.
 */
export async function scheduledProjectRunner(request: ScheduledProjectRequest): Promise<{ cardId: number; result: string }> {
  const { entryId, runId, executionControl } = request;
  const goal = buildOrcGoal(request);

  const state = readState(entryId);
  const activeRun = state?.activeRun;
  if (activeRun && activeRun.runId !== runId) {
    throw new Error(`scheduled project admission conflict: run ${activeRun.runId} is active for task "${entryId}"`);
  }

  let rootCardId: number;
  const reattached = activeRun !== undefined && activeRun.cardId !== undefined;
  if (reattached) {
    rootCardId = activeRun!.cardId!;
    const existing = kanbanGetCard(rootCardId);
    if (!existing) throw new Error(`scheduled project card #${rootCardId} not found`);
    if (existing.type !== "O" || existing.source !== "task" || existing.source_id !== runId) {
      throw new Error(`scheduled project card #${rootCardId} identity conflict for run ${runId}`);
    }
    executionControl.setCardId(rootCardId);
    logInfo(TAG, `Reattaching scheduled project card #${rootCardId} for task "${entryId}" run ${runId}`);
  } else {
    // #1516: the root card durably carries the scheduled run correlation
    // (source_id) and the absolute deadline (due_at) alongside the agent cap.
    rootCardId = kanbanEnqueue(request.title, "task", runId, {
      priority: request.priority.toUpperCase() as "HIGH" | "MEDIUM" | "LOW",
      type: "O",
      goal,
      due_at: new Date(request.deadlineAt).toISOString(),
      delivery: request.delivery,
      chatId: request.chatId,
      maxAgents: request.maxAgents,
      deliveryReady: false,
    });
    if (rootCardId === 0) throw new Error("scheduled project admission failed: kanban database unavailable");
    executionControl.setCardId(rootCardId);
    updateActiveRun(entryId, runId, { cardId: rootCardId });
    logInfo(TAG, `Admitted scheduled project card #${rootCardId} for task "${entryId}" run ${runId} maxAgents=${request.maxAgents}`);
  }

  const reviewStore = new ProjectReviewStore();
  reviewStore.ensureAwaitingContract(rootCardId);

  const coordinator = getOrCreateOrcCoordinator();
  if (!coordinator) throw new Error("scheduled project admission failed: Orc coordinator unavailable");

  const supervision = reviewStore.getSupervision(rootCardId);
  const needsAuthoringTurn = !supervision || supervision.state === "awaiting_contract";
  if (needsAuthoringTurn) {
    const claim = coordinator.scheduleScheduledProject(rootCardId, goal);
    if (claim.kind === "conflict" || claim.kind === "not_actionable") {
      throw new Error(`scheduled project admission failed: ${claim.reason}`);
    }
  }

  // The Reconciler only supervises running O cards; the Orc turn also marks
  // the card running, but this guarantees supervision regardless of dispatch
  // gate state.
  const currentCard = kanbanGetCard(rootCardId);
  if (currentCard?.status === "queued") kanbanRunning(rootCardId);

  executionControl.bind(async (reason) => {
    logInfo(TAG, `Scheduled project #${rootCardId} cancelled: ${reason}`);
    await abortProjectById(rootCardId, `scheduled cancellation: ${reason}`);
  });

  return waitForProjectTerminal(request, rootCardId);
}

/**
 * #1516: machine-derived facts appended to the task prompt — the Orc does not
 * need the task author to restate the cap, deadline, or artifact ownership.
 */
function buildOrcGoal(request: ScheduledProjectRequest): string {
  const workerLimit = request.maxAgents - 1;
  const sections: string[] = [
    `[SCHEDULED TASK PROJECT — ${request.title}]`,
    `Scheduled task: ${request.entryId} (run ${request.runId})`,
    `Absolute deadline: ${new Date(request.deadlineAt).toISOString()} — the scheduled system enforces it; never exceed it.`,
    `Agent budget: ${request.maxAgents} total agents (1 Orc + up to ${workerLimit} concurrent Workers). The system enforces this cap — do not attempt to exceed it.`,
    `Lane discipline: each Worker must own an independent, disjoint work lane. Never spawn duplicate Workers for the same source.`,
    `Artifact ownership: Workers must NOT write the declared final report artifact. They return bounded lane results/evidence only.`,
    `Workspace: ${request.executionScope.cwd}`,
  ];
  if (request.reportArtifactPath) {
    sections.push(`Final report: you (Orc) are the sole writer of ${request.reportArtifactPath}. Wait for all Worker outcomes, handle partial Worker failure explicitly, synthesize the final report, and write it before submitting your review.`);
  }
  sections.push(
    `Delivery mode: ${request.delivery}`,
    `Complete the supervised lifecycle: define the project contract, spawn Workers, wait for their outcomes, then submit review_project (accept/repair/blocked).`,
    ``,
    `[TASK]`,
    request.goal,
  );
  return sections.join("\n");
}

type ProjectTerminalRead =
  | { accepted: true; synthesis: string }
  | { accepted: false; reason: string };

function readProjectTerminal(rootCardId: number): ProjectTerminalRead | undefined {
  const reviewStore = new ProjectReviewStore();
  const supervision = reviewStore.getSupervision(rootCardId);
  const card = kanbanGetCard(rootCardId);
  if (!card) return undefined;
  if (supervision?.state === "accepted" || card.status === "done") {
    let synthesis = card.result_summary ?? "";
    if (supervision?.accepted_decision_id) {
      const decision = reviewStore.getDecision(supervision.accepted_decision_id);
      if (decision) {
        try {
          const parsed = JSON.parse(decision.decision_json) as { synthesis?: unknown };
          if (typeof parsed.synthesis === "string" && parsed.synthesis) synthesis = parsed.synthesis;
        } catch { /* keep the card summary */ }
      }
    }
    return { accepted: true, synthesis: synthesis || "project accepted" };
  }
  if (supervision?.state === "blocked" || card.status === "failed") {
    return { accepted: false, reason: (supervision?.blocked_reason ?? card.error ?? "project blocked").slice(0, 500) };
  }
  return undefined;
}

/**
 * #1516: Wait for the supervised project to reach a terminal state.
 * Event subscription plus a bounded recheck avoids a subscribe-after-terminal
 * race; deadline and execution-control cancellation abort the project and
 * settle through the scheduled runner's existing exactly-once path.
 */
function waitForProjectTerminal(request: ScheduledProjectRequest, rootCardId: number): Promise<{ cardId: number; result: string }> {
  return new Promise((resolve, reject) => {
    const { executionControl, deadlineAt } = request;
    let finished = false;
    let cleanup: () => void = () => {};
    const finish = (fn: () => void): void => {
      if (finished) return;
      finished = true;
      cleanup();
      fn();
    };
    const check = (): void => {
      if (finished) return;
      if (executionControl.cancelled) {
        finish(() => reject(new Error(`scheduled project cancelled: ${executionControl.cancelReason ?? "cancelled"}`)));
        return;
      }
      if (Date.now() >= deadlineAt) {
        void abortProjectById(rootCardId, "scheduled deadline exceeded");
        finish(() => reject(new Error("scheduled project deadline exceeded")));
        return;
      }
      const terminal = readProjectTerminal(rootCardId);
      if (terminal) {
        finish(() => {
          if (terminal.accepted) {
            resolve({ cardId: rootCardId, result: terminal.synthesis });
          } else {
            reject(new Error(terminal.reason));
          }
        });
      }
    };
    const onCardEvent = (cardId: number): void => {
      if (cardId === rootCardId) check();
    };
    nerve.on("card:done", onCardEvent);
    nerve.on("card:failed", onCardEvent);
    const timer = setInterval(check, RECHECK_INTERVAL_MS);
    cleanup = () => {
      nerve.off("card:done", onCardEvent);
      nerve.off("card:failed", onCardEvent);
      clearInterval(timer);
    };
    check();
  });
}
