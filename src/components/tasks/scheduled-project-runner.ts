/**
 * scheduled-project-runner.ts — #1516: supervised-project execution for
 * scheduled agent tasks with `orchestration.maxAgents > 1`.
 *
 * Bridges the scheduled lifecycle (preflight, absolute deadline, report
 * validation, exactly-once settlement, retry, delivery — all owned by
 * ScheduledTaskRunner) to the generic workflow runner (#1792): one root O
 * card carrying the durable agent cap, runner admission with the scheduled
 * occurrence identity, model planning through the planner backend, supervised
 * workers bounded by the cap, review verdicts, and terminal evidence read
 * from the run row plus its card projection.
 */

import { nerve } from "../nerve.js";
import { logInfo } from "../logger.js";
import { kanbanEnqueue, kanbanRunning, kanbanGetCard, kanbanGetChildren } from "./kanban-board.js";
import { readState, advanceRun } from "./task-state-store.js";
import { WorkflowRunner } from "../orc-project/orc-workflow-runner.js";
import { WorkflowStore } from "../orc-project/orc-workflow-store.js";
import { WorkerSupervisionStore } from "../worker-supervision-store.js";
import { makeTaskFailure } from "./task-failure.js";
import type { TaskFailureDiagnosticV1, TaskFailureLaneFact } from "./task-failure.js";
import type { ExecutionControl } from "../execution-control.js";
import type { ToolExecutionScope } from "./task-package.js";
import type { Delivery } from "./task-types.js";

const TAG = "scheduled-project-runner";
const RECHECK_INTERVAL_MS = 10_000;

let sharedRunner: WorkflowRunner | null = null;
/** Runner bound to the shared task database (stateless logic, DB-serialized). */
function workflowRunner(): WorkflowRunner {
  if (!sharedRunner) sharedRunner = new WorkflowRunner(new WorkflowStore());
  return sharedRunner;
}

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
 * #1792: Admit a scheduled agent task as a supervised workflow run.
 *
 * Admission is synchronous until the runner admission + initial planning
 * command are durable, so the goal-bearing admission always races ahead of
 * any periodic wake for the same card. Workspace binding, supervision anchor,
 * and budgets all commit inside runner admission (idempotent by client
 * operation id — reattach replays safely).
 */
export async function scheduledProjectRunner(request: ScheduledProjectRequest): Promise<{ cardId: number; result: string }> {
  const { entryId, runId, executionControl } = request;
  const cancellationState: ProjectCancellationState = { abortStarted: false };

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
    // Idempotent runner admission: the same client operation id replays to a
    // duplicate (proceed), a terminal run resolves in the waiter below, and
    // workspace mismatch fails closed inside admission.
    const admitted = workflowRunner().admitSupervised({
      rootCardId, source: "task", sourceId: runId, scheduledRunId: runId,
      cwd: request.executionScope.cwd,
    });
    if (admitted.kind === "conflict") {
      throw new Error(`scheduled project admission failed: ${admitted.reason}`);
    }
    const currentCard = kanbanGetCard(rootCardId);
    if (currentCard?.status === "queued") kanbanRunning(rootCardId);
    bindProjectCancellation(executionControl, rootCardId, cancellationState);
    return waitForProjectTerminal(request, rootCardId, cancellationState);
  } else {
    // #1516: the root card durably carries the scheduled run correlation
    // (source_id) and the absolute deadline (due_at) alongside the agent cap.
    rootCardId = kanbanEnqueue(request.title, "task", runId, {
      priority: request.priority.toUpperCase() as "HIGH" | "MEDIUM" | "LOW",
      type: "O",
      goal: request.goal,
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

  const admitted = workflowRunner().admitSupervised({
    rootCardId, source: "task", sourceId: runId, scheduledRunId: runId,
    cwd: request.executionScope.cwd,
  });
  if (admitted.kind === "conflict") {
    throw new Error(`scheduled project admission failed: ${admitted.reason}`);
  }

  // The runner owns supervised progression from here; the card runs while
  // work is outstanding regardless of dispatch gate state.
  const currentCard = kanbanGetCard(rootCardId);
  if (currentCard?.status === "queued") kanbanRunning(rootCardId);

  bindProjectCancellation(executionControl, rootCardId, cancellationState);

  return waitForProjectTerminal(request, rootCardId, cancellationState);
}

type ProjectTerminalRead =
  | { accepted: true; synthesis: string; factAt?: number }
  | { accepted: false; diagnostic: TaskFailureDiagnosticV1; factAt?: number };

interface ProjectCancellationState {
  abortStarted: boolean;
}

function bindProjectCancellation(
  executionControl: ExecutionControl,
  rootCardId: number,
  state: ProjectCancellationState,
): void {
  executionControl.bind((reason) => {
    // If the project was already terminal when cancellation arrived, preserve
    // that child fact for the shared settler's request-time precedence check.
    if (readWorkflowTerminal(rootCardId)) return;
    state.abortStarted = true;
    logInfo(TAG, `Scheduled project #${rootCardId} cancelled: ${reason}`);
    const run = workflowRunner().store.findRunByCard(rootCardId);
    if (run) {
      try {
        workflowRunner().requestCancel(run.runId, `scheduled cancellation: ${reason}`);
      } catch (err) {
        logInfo(TAG, `Scheduled project #${rootCardId} cancel contained: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
}

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

function readWorkflowTerminal(rootCardId: number): ProjectTerminalRead | undefined {
  const runner = workflowRunner();
  const run = runner.store.findLatestRunByCard(rootCardId);
  const card = kanbanGetCard(rootCardId);
  if (!card) return undefined;
  const runTerminal = run && (run.state === "succeeded" || run.state === "failed" || run.state === "cancelled") ? run : null;
  if (runTerminal) {
    if (runTerminal.state === "succeeded") {
      return { accepted: true, synthesis: card.result_summary || "project accepted", factAt: cardTimeMs(card.updated_at) };
    }
    const reason = (runTerminal.failureReason ?? runTerminal.failureCode ?? "project blocked").slice(0, 500);
    const lanes = gatherLaneFacts(rootCardId);
    const diagnostic = makeTaskFailure("supervision", "project_blocked", "executing",
      reason, "none",
      {
        rootCardId,
        lanes,
        remediationHint: reason,
      });
    return { accepted: false, diagnostic, factAt: cardTimeMs(card.updated_at) };
  }
  // Legacy compat: pre-cutover terminal cards without a workflow run.
  if (card.status === "done" || card.status === "delivered") {
    return { accepted: true, synthesis: card.result_summary || "project accepted", factAt: cardTimeMs(card.updated_at) };
  }
  if (card.status === "failed") {
    const reason = (card.error ?? "project blocked").slice(0, 500);
    const lanes = gatherLaneFacts(rootCardId);
    const { code, message } = selectSupervisionCode(lanes, []);
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
function waitForProjectTerminal(
  request: ScheduledProjectRequest,
  rootCardId: number,
  cancellationState: ProjectCancellationState,
): Promise<{ cardId: number; result: string; factAt?: number }> {
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
      const terminalRequest = readState(request.entryId)?.activeRun?.terminalRequest;
      const deadlineRequested = terminalRequest?.kind === "deadline_exceeded";
      if (executionControl.cancelled && (!deadlineRequested || cancellationState.abortStarted)) {
        finish(() => reject(new Error(`scheduled project cancelled: ${executionControl.cancelReason ?? "cancelled"}`)));
        return;
      }
      // Heal projections before reading terminal evidence: a run that reached
      // a terminal state before its projection commit crashed still carries
      // its own fact time and settles on its merits in the settler.
      try {
        const latest = workflowRunner().store.findLatestRunByCard(rootCardId);
        if (latest && (latest.state === "succeeded" || latest.state === "failed" || latest.state === "cancelled")) {
          workflowRunner().projectTerminalProjections(latest.runId);
        }
      } catch {
        // Retried next tick; terminal evidence below is unaffected.
      }
      const terminal = readWorkflowTerminal(rootCardId);
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
      if (executionControl.cancelled) {
        finish(() => reject(new Error(`scheduled project cancelled: ${executionControl.cancelReason ?? "cancelled"}`)));
        return;
      }
      if (Date.now() >= deadlineAt) {
        const live = workflowRunner().store.findRunByCard(rootCardId);
        if (live) {
          try {
            workflowRunner().requestCancel(live.runId, "scheduled deadline exceeded");
          } catch {
            // Cancellation races terminal settlement; the terminal read above wins.
          }
        }
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
