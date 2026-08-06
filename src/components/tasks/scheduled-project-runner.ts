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
import { kanbanEnqueue, kanbanRunning, kanbanGetCard, kanbanGetChildren } from "./kanban-board.js";
import { readState, advanceRun } from "./task-state-store.js";
import { ProjectReviewStore } from "../project-acceptance/project-review-store.js";
import { abortProjectById, getOrCreateOrcCoordinator, requestReconcileForProject } from "../reconciler.js";
import { WorkerSupervisionStore } from "../worker-supervision-store.js";
import { makeTaskFailure } from "./task-failure.js";
import type { TaskFailureDiagnosticV1, TaskFailureLaneFact } from "./task-failure.js";
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
  /** #1588: per-lane hard duration budget (ms) the Orc must not under-author. */
  laneDurationMs?: number;
}

export type ScheduledProjectRunner = (
  request: ScheduledProjectRequest,
) => Promise<{ cardId: number; result: string; factAt?: number }>;

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
    const reviewStore = new ProjectReviewStore();
    const supervision = reviewStore.getSupervision(rootCardId);
    const cardTerminal = ["done", "delivered", "failed"].includes(existing.status);
    const terminalEvidence = cardTerminal || supervision?.state === "accepted" || supervision?.state === "blocked";

    if (terminalEvidence) {
      // #1546 R5: terminal reattach reads terminal evidence; no supervision
      // insertion and no new Orc claim.
      logInfo(TAG, `Scheduled project #${rootCardId} already terminal on reattach — waiting for terminal evidence`);
      executionControl.bind(async (reason) => {
        logInfo(TAG, `Scheduled project #${rootCardId} cancelled: ${reason}`);
        await abortProjectById(rootCardId, `scheduled cancellation: ${reason}`);
      });
      return waitForProjectTerminal(request, rootCardId);
    }

    if (!supervision || supervision.state === "awaiting_contract") {
      // #1546 R5: a reattached project without a contract keeps the
      // synchronous goal-bearing claim so the machine-derived task goal wins
      // over a generic Reconciler authoring wake for the same card.
      reviewStore.ensureAwaitingContract(rootCardId);
      const coordinator = getOrCreateOrcCoordinator();
      if (!coordinator) throw new Error("scheduled project admission failed: Orc coordinator unavailable");
      const claim = coordinator.scheduleScheduledProject(rootCardId, goal);
      if (claim.kind === "conflict" || claim.kind === "not_actionable") {
        throw new Error(`scheduled project admission failed: ${claim.reason}`);
      }
      const currentCard = kanbanGetCard(rootCardId);
      if (currentCard?.status === "queued") kanbanRunning(rootCardId);
    } else {
      // #1546 R5: any other non-terminal reattach state does not author a new
      // contract and is never promoted directly. The shared driver owns the
      // due check, claim-before-promotion order, retry-marker clearing, and
      // owner selection (review, input, repair, Worker resume, Orc
      // continuation, or last-resort settlement).
      logInfo(TAG, `Scheduled project #${rootCardId} reattached in ${supervision.state} — waking the shared Reconciler driver`);
      requestReconcileForProject(rootCardId);
    }

    executionControl.bind(async (reason) => {
      logInfo(TAG, `Scheduled project #${rootCardId} cancelled: ${reason}`);
      await abortProjectById(rootCardId, `scheduled cancellation: ${reason}`);
    });

    return waitForProjectTerminal(request, rootCardId);
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
    advanceRun(entryId, runId, { attachments: { cardId: rootCardId } });
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
    `Lane budgets: ${request.laneDurationMs !== undefined ? `every lane carries a hard max_duration_ms of ${request.laneDurationMs} ms; ` : ""}a lane that fetches live web pages needs >= 300000 ms (max_duration_ms). Every declared criterion MUST have an evidence path - a verification command or a required artifact - or the contract is rejected.`,
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
  | { accepted: true; synthesis: string; factAt?: number }
  | { accepted: false; diagnostic: TaskFailureDiagnosticV1; factAt?: number };

/**
 * #1588: a typed carrier for a non-accepted supervised project. The diagnostic
 * is built from durable lane facts so the settler can report the root cause
 * verbatim instead of re-classifying a flattened string.
 */
export class SupervisedProjectFailure extends Error {
  constructor(
    readonly diagnostic: TaskFailureDiagnosticV1,
    readonly factAt?: number,
  ) {
    super(diagnostic.message);
    this.name = "SupervisedProjectFailure";
  }
}

function cardTimeMs(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  // SQLite `datetime('now')` writes UTC without a timezone marker; bare
  // date-time strings would be parsed as LOCAL time and shift the fact time.
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const t = new Date(normalized).getTime();
  return Number.isFinite(t) ? t : undefined;
}

type ParsedWorkerContract = {
  id: string;
  criteria: Array<{ id: string }>;
  verificationCommands: Array<{ criterion_ids: string[] }>;
  expectedArtifacts: Array<{ required: boolean; criterion_ids: string[] }>;
  maxDurationMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse enough of a durable contract to report a lane even if a row is malformed. */
function parseWorkerContract(contractRow: { id: string; contract_json: string }): ParsedWorkerContract {
  const fallback: ParsedWorkerContract = {
    id: contractRow.id,
    criteria: [],
    verificationCommands: [],
    expectedArtifacts: [],
  };
  let raw: unknown;
  try {
    raw = JSON.parse(contractRow.contract_json) as unknown;
  } catch {
    return fallback;
  }
  if (!isRecord(raw)) return fallback;

  const criteria = Array.isArray(raw["criteria"])
    ? raw["criteria"].filter((value): value is Record<string, unknown> => isRecord(value) && typeof value["id"] === "string")
      .map((value) => ({ id: value["id"] as string }))
    : [];
  const verificationCommands = Array.isArray(raw["verification_commands"])
    ? raw["verification_commands"].filter((value): value is Record<string, unknown> => isRecord(value) && Array.isArray(value["criterion_ids"]))
      .map((value) => ({ criterion_ids: (value["criterion_ids"] as unknown[]).filter((id): id is string => typeof id === "string") }))
    : [];
  const expectedArtifacts = Array.isArray(raw["expected_artifacts"])
    ? raw["expected_artifacts"].filter((value): value is Record<string, unknown> => isRecord(value) && Array.isArray(value["criterion_ids"]))
      .map((value) => ({
        required: value["required"] === true,
        criterion_ids: (value["criterion_ids"] as unknown[]).filter((id): id is string => typeof id === "string"),
      }))
    : [];
  const limits = isRecord(raw["limits"]) ? raw["limits"] : undefined;
  return {
    id: typeof raw["id"] === "string" && raw["id"] ? raw["id"] : contractRow.id,
    criteria,
    verificationCommands,
    expectedArtifacts,
    ...(limits && typeof limits["max_duration_ms"] === "number" && Number.isFinite(limits["max_duration_ms"])
      ? { maxDurationMs: limits["max_duration_ms"] }
      : {}),
  };
}

/** #1588: per-lane facts from worker_attempts / worker_contracts / worker_results. */
function gatherLaneFacts(rootCardId: number): TaskFailureLaneFact[] {
  const supStore = new WorkerSupervisionStore();
  const lanes: TaskFailureLaneFact[] = [];
  for (const child of kanbanGetChildren(rootCardId)) {
    const contractRow = supStore.getContractByCardId(child.id);
    const attempt = supStore.getLatestAttempt(child.id);
    if (!contractRow || !attempt) continue;
    const contract = parseWorkerContract(contractRow);
    let result: ReturnType<WorkerSupervisionStore["getResultByAttempt"]>;
    try {
      result = supStore.getResultByAttempt(attempt.id);
    } catch {
      // A corrupt result must not hide the durable attempt failure. Fall back
      // to the contract criteria as evidence-of-absence.
      result = undefined;
    }
    const resultCriteria = result && isRecord(result.envelope) && Array.isArray(result.envelope["criteria"])
      ? result.envelope["criteria"].filter((value): value is Record<string, unknown> =>
        isRecord(value) && typeof value["criterion_id"] === "string" && typeof value["status"] === "string")
        .map((value) => ({ id: value["criterion_id"] as string, status: value["status"] as string }))
      : [];
    const criteria = resultCriteria.length > 0
      ? resultCriteria
      : contract.criteria.map((c) => ({ id: c.id, status: "not_run" }));
    const missingEvidence = contract.criteria
      .filter((c) =>
        !contract.verificationCommands.some((v) => v.criterion_ids.includes(c.id)) &&
        !contract.expectedArtifacts.some((a) => a.required && a.criterion_ids.includes(c.id)))
      .map((c) => c.id);
    const hardDeadlineAt = typeof attempt.hard_deadline_at === "string" ? attempt.hard_deadline_at : undefined;
    const settledAt = typeof attempt.settled_at === "string" ? attempt.settled_at : undefined;
    const deadlineMs = cardTimeMs(hardDeadlineAt);
    const settledMs = cardTimeMs(settledAt);
    const overrunMs = deadlineMs !== undefined && settledMs !== undefined
      ? settledMs - deadlineMs
      : undefined;
    const bindingLimit = contract.maxDurationMs !== undefined
      ? { name: "max_duration_ms", value: contract.maxDurationMs }
      : undefined;

    lanes.push({
      cardId: child.id,
      contractId: contract.id,
      attemptId: attempt.id,
      lifecycle: attempt.lifecycle,
      ...(attempt.cancel_reason ? { cancelReason: attempt.cancel_reason } : {}),
      ...(hardDeadlineAt ? { hardDeadlineAt } : {}),
      ...(settledAt ? { settledAt } : {}),
      ...(overrunMs !== undefined && Number.isFinite(overrunMs) ? { overrunMs } : {}),
      ...(bindingLimit ? { bindingLimit } : {}),
      criteria,
      missingEvidence,
    });
  }
  return lanes;
}

/** #1588: root criteria with no child contract mapping them. */
function uncoveredRootCriteria(rootCardId: number): string[] {
  const reviewStore = new ProjectReviewStore();
  const rootRow = reviewStore.getContractByProjectCardId(rootCardId);
  if (!rootRow) return [];
  let rootContract: unknown;
  try {
    rootContract = JSON.parse(rootRow.contract_json) as unknown;
  } catch { return []; }
  if (!isRecord(rootContract) || !Array.isArray(rootContract["criteria"])) return [];
  const rootCriteria = rootContract["criteria"].filter((value): value is Record<string, unknown> =>
    isRecord(value) && typeof value["id"] === "string");
  const mapped = new Set<string>();
  const supStore = new WorkerSupervisionStore();
  for (const child of kanbanGetChildren(rootCardId)) {
    const contractRow = supStore.getContractByCardId(child.id);
    if (!contractRow) continue;
    try {
      const c = JSON.parse(contractRow.contract_json) as unknown;
      if (!isRecord(c) || !Array.isArray(c["supports_root_criteria"])) continue;
      for (const id of c["supports_root_criteria"]) {
        if (typeof id === "string") mapped.add(id);
      }
    } catch { /* skip */ }
  }
  return rootCriteria.filter((c) => !mapped.has(c["id"] as string)).map((c) => c["id"] as string);
}

/**
 * #1588: code selection precedence — the most actionable definition-shaped
 * fault wins over the lane outcome it produced.
 */
function selectSupervisionCode(
  lanes: TaskFailureLaneFact[],
  uncovered: readonly string[],
): { code: string; message: string } {
  if (uncovered.length > 0) {
    return {
      code: "contract_uncovered",
      message: `root criteria without a mapped child contract: ${uncovered.join(", ")}`,
    };
  }
  const unevidenced = new Set<string>();
  for (const lane of lanes) for (const id of lane.missingEvidence) unevidenced.add(id);
  if (unevidenced.size > 0) {
    return {
      code: "criterion_unevidenced",
      message: `criterion without an evidence path: ${[...unevidenced].join(", ")}`,
    };
  }
  for (const lane of lanes) {
    if (lane.lifecycle === "timed_out" && lane.cancelReason?.includes("late_completion")) {
      const overrun = lane.overrunMs !== undefined ? ` (overrun ${lane.overrunMs}ms)` : "";
      return {
        code: "lane_late_completion",
        message: `lane card ${lane.cardId} completed after its hard deadline${overrun}; result rejected`,
      };
    }
  }
  for (const lane of lanes) {
    if (lane.lifecycle === "timed_out") {
      return { code: "lane_timed_out", message: `lane card ${lane.cardId} hit its hard deadline with no result` };
    }
  }
  for (const lane of lanes) {
    if (lane.lifecycle === "failed" || lane.lifecycle === "cancelled") {
      return { code: "lane_failed", message: `lane card ${lane.cardId} settled ${lane.lifecycle}` };
    }
  }
  return { code: "project_blocked", message: "project blocked" };
}

function readProjectTerminal(rootCardId: number): ProjectTerminalRead | undefined {
  const reviewStore = new ProjectReviewStore();
  const supervision = reviewStore.getSupervision(rootCardId);
  const card = kanbanGetCard(rootCardId);
  if (!card) return undefined;
  if (supervision?.state === "accepted" || card.status === "done") {
    let synthesis = card.result_summary ?? "";
    let factAt = cardTimeMs(card.updated_at);
    if (supervision?.accepted_decision_id) {
      const decision = reviewStore.getDecision(supervision.accepted_decision_id);
      if (decision) {
        try {
          const parsed = JSON.parse(decision.decision_json) as { synthesis?: unknown };
          if (typeof parsed.synthesis === "string" && parsed.synthesis) synthesis = parsed.synthesis;
        } catch { /* keep the card summary */ }
        factAt = cardTimeMs(decision.created_at) ?? factAt;
      }
    }
    return { accepted: true, synthesis: synthesis || "project accepted", factAt };
  }
  if (supervision?.state === "blocked" || card.status === "failed") {
    const reason = (supervision?.blocked_reason ?? card.error ?? "project blocked").slice(0, 500);
    const lanes = gatherLaneFacts(rootCardId);
    const uncovered = uncoveredRootCriteria(rootCardId);
    const { code, message } = selectSupervisionCode(lanes, uncovered);
    const diagnostic = makeTaskFailure("supervision", code, "executing",
      code === "project_blocked" ? reason : message, "none",
      {
        rootCardId,
        lanes,
        remediationHint: code === "project_blocked" ? reason : undefined,
      });
    return { accepted: false, diagnostic, factAt: cardTimeMs(card.updated_at) };
  }
  return undefined;
}

/**
 * #1516: Wait for the supervised project to reach a terminal state.
 * Event subscription plus a bounded recheck avoids a subscribe-after-terminal
 * race; deadline and execution-control cancellation abort the project and
 * settle through the scheduled runner's existing exactly-once path.
 */
function waitForProjectTerminal(request: ScheduledProjectRequest, rootCardId: number): Promise<{ cardId: number; result: string; factAt?: number }> {
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
      // #1539: terminal evidence is read BEFORE the deadline abort. A project
      // that reached a terminal state before its deadline but is observed
      // after it (recheck interval) carries its own fact time and settles on
      // its merits in the settler.
      const terminal = readProjectTerminal(rootCardId);
      if (terminal) {
        finish(() => {
          if (terminal.accepted) {
            resolve({ cardId: rootCardId, result: terminal.synthesis, factAt: terminal.factAt });
          } else {
            reject(new SupervisedProjectFailure(terminal.diagnostic, terminal.factAt));
          }
        });
        return;
      }
      if (Date.now() >= deadlineAt) {
        void abortProjectById(rootCardId, "scheduled deadline exceeded");
        finish(() => reject(new Error("scheduled project deadline exceeded")));
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
