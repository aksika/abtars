import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { abtarsHome } from "../../paths.js";
import { logInfo, logWarn } from "../logger.js";
import { advanceRun, requestRunTerminal, readState } from "./task-state-store.js";
import { preflightTask, validateReportArtifact } from "./task-preflight.js";
import type { TaskToolRegistry } from "./task-preflight.js";
import { settleRunOnce } from "./task-run-settler.js";
import { makeTaskFailure } from "./task-failure.js";
import { SupervisedProjectFailure } from "./scheduled-project-runner.js";
import { isProviderExecutionError } from "../transport/provider-failure.js";
import { createExecutionScope } from "./task-package.js";
import type { ExecutionControl, ExecutionSupervisor } from "../execution-control.js";
import { SpinDispatchAdmissionError } from "../spin-types.js";
import { spin as spinFacade } from "../spin.js";
import { kanbanEnqueue } from "./kanban-board.js";
import { logTaskDebug, logTaskTrace } from "./task-log-ctx.js";
import { readLastPromptAt } from "../transport/bridge-lock-transport.js";
import type { ScheduledTask } from "./task-types.js";
import { formatTaskLabel } from "./task-types.js";
import { readEntries as readTaskEntries } from "./task-store.js";
import type { ActiveTaskRun } from "./task-state-store.js";
import type { ResolvedReportContract, ArtifactBaseline } from "./task-preflight.js";
import type { TaskFailureDiagnosticV1 } from "./task-failure.js";

const TAG = "scheduled-task-runner";

export interface ScheduledTaskRunOutcome {
  status: "success" | "definition_failed" | "failed" | "timed_out" | "cancelled" | "deferred";
  safeDetail?: string;
  artifactPath?: string;
  cardId?: number;
}

export type AgentTaskRunner = (request: import("../spin-types.js").SpinRequest) => Promise<{ cardId: number; result: string; outcome: import("../clean-response.js").ContentOutcome }>;
export type TaskPausedCallback = (chatId: number, title: string, reason: string, notice: import("./task-run-settler.js").PauseNotice) => void;
/** #1688: the failure cascade carries one typed `ScheduledFailureEvent`. */
export type TaskFailureCallback = (event: import("../sha/sha-types.js").ScheduledFailureEvent) => void;
export type { ScheduledProjectRequest, ScheduledProjectRunner } from "./scheduled-project-runner.js";

/** #1540: the production supervisor is the facade's own instance — never a second registry. */
function resolveDefaultExecutions(): ExecutionSupervisor {
  return spinFacade.executionSupervisor;
}

export class ScheduledTaskRunner {
  private readonly agentRunner?: AgentTaskRunner;
  private readonly projectRunner?: import("./scheduled-project-runner.js").ScheduledProjectRunner;
  private readonly onPaused?: (entryId: string, diagnostic: TaskFailureDiagnosticV1, notice: import("./task-run-settler.js").PauseNotice) => void;
  private readonly onFailure?: TaskFailureCallback;
  private readonly executions: ExecutionSupervisor;

  constructor(opts?: { agentRunner?: AgentTaskRunner; onTaskPaused?: TaskPausedCallback; onFailure?: TaskFailureCallback; projectRunner?: import("./scheduled-project-runner.js").ScheduledProjectRunner; executions?: ExecutionSupervisor }) {
    this.agentRunner = opts?.agentRunner;
    this.projectRunner = opts?.projectRunner;
    // #1540: the single shared live supervisor (Spin's own instance by default).
    this.executions = opts?.executions ?? resolveDefaultExecutions();
    // #1588: the failure cascade is passed through to every settle — the
    // settler's exactly-once placement is the single reporting point.
    this.onFailure = opts?.onFailure;
    // #1520: pause notification emitted once by the shared settler on the
    // false→true transition, keeping operator presentation in one place.
    if (opts?.onTaskPaused) {
      this.onPaused = (entryId, diagnostic, notice) => {
        const entry = readTaskEntries().find((e: ScheduledTask) => e.id === entryId);
        opts.onTaskPaused?.(parseInt(entry?.chatId ?? "0", 10), formatTaskLabel(entryId), `paused: ${diagnostic.category}/${diagnostic.code}: ${diagnostic.message.slice(0, 150)}`, notice);
      };
    }
  }

  private resolveProjectRunner(): import("./scheduled-project-runner.js").ScheduledProjectRunner {
    if (this.projectRunner) return this.projectRunner;
    const { scheduledProjectRunner } = require("./scheduled-project-runner.js") as typeof import("./scheduled-project-runner.js");
    return scheduledProjectRunner;
  }

  async run(entry: ScheduledTask & { kind: "agent" }, reservation: ActiveTaskRun): Promise<ScheduledTaskRunOutcome> {
    const taskId = entry.id;
    const runId = reservation.runId;
    const factNow = (): number => Date.now();
    logTaskDebug("task_execution_started", { task: entry.id, run: reservation.runId, attempt: reservation.attempt });

    try {
      if (!reservation.trigger || reservation.trigger === "schedule") {
        const idleMs = Date.now() - readLastPromptAt();
        if (idleMs < 90_000) {
          logInfo(TAG, `Deferring agent task "${entry.id}" — user active ${Math.round(idleMs / 1000)}s ago`);
          // #1520: bounded durable deferral of the same occurrence — never a
          // silent drop and never a task-content failure. The settler enforces
          // the 5-attempt / 1-minute / original-deadline bound.
          settleRunOnce({
            entry, run: reservation, outcome: "deferred",
            diagnostic: makeTaskFailure("admission", "session_capacity", "reserved",
              `user active ${Math.round(idleMs / 1000)}s ago — deferring this occurrence`, "transient"),
            detail: `idle_gate:user_active`,
          });
          logTaskDebug("task_deferred", { task: entry.id }, `reason=idle_gate`);
          return { status: "deferred", safeDetail: "idle_gate" };
        }
      }

      // #1602: the runner's invariant is a normalized agent entry. A direct
      // raw-entry caller must settle as a definition failure, never turn a
      // definition defect into a TypeError classified as an execution failure.
      const interaction = (entry as { interaction?: unknown }).interaction;
      const mode = interaction && typeof interaction === "object"
        ? (interaction as { mode?: unknown }).mode
        : undefined;
      if (mode !== "oneshot" && mode !== "skill") {
        const detail = `task "${entry.id}" has an unnormalized interaction definition`;
        logWarn(TAG, `${detail} — settled as definition_failed without dispatch`);
        settleRunOnce({
          entry, run: reservation, outcome: "definition_failed",
          diagnostic: makeTaskFailure("definition", "invalid_definition", "preflight", detail, "permanent"),
          detail, factAt: factNow(),
          onPaused: this.onPaused,
          onFailure: this.onFailure,
        });
        return { status: "definition_failed", safeDetail: detail };
      }

      let prompt = entry.prompt ?? "";
      let resolvedContract: ResolvedReportContract | undefined;
      let artifactBaseline: ArtifactBaseline | undefined;

      if (entry.taskFile) {
        advanceRun(taskId, runId, { phase: "preflight" });
        const { loadTaskPackage } = await import("./task-package.js");
        const task = loadTaskPackage(entry.taskFile);
        if (task.ok) {
          prompt = task.prompt;
        } else {
          logWarn(TAG, `Falling back to inline prompt for "${entry.id}": ${task.error}`);
        }
      }

      const executionScope = createExecutionScope(entry.id);
      const toolRegistry = await getToolRegistry();

      if (entry.delivery === "report") {
        advanceRun(taskId, runId, { phase: "preflight" });
        logTaskTrace("task_preflight_started", { task: entry.id, run: reservation.runId });
        const preflight = preflightTask(entry, executionScope, toolRegistry);
        if (!preflight.ok) {
          logTaskTrace("task_preflight_failed", { task: entry.id }, `code=${preflight.code}`);
          settleRunOnce({
            entry, run: reservation, outcome: "definition_failed",
            diagnostic: makeTaskFailure("definition", preflight.code, "preflight", preflight.safeDetail, "permanent"),
            detail: preflight.safeDetail, cardId: undefined, factAt: factNow(),
          });
          return { status: "definition_failed", safeDetail: preflight.safeDetail };
        }
        logTaskTrace("task_preflight_passed", { task: entry.id, run: reservation.runId });
        resolvedContract = preflight.report;
        artifactBaseline = preflight.artifactBaseline;
      }

      const contextFile = join(abtarsHome(), "workspace", entry.id, "CONTEXT.md");
      if (existsSync(contextFile)) {
        const raw = readFileSync(contextFile, "utf-8").trim();
        if (raw) {
          const ctx = raw.length > 30000 ? (logWarn(TAG, `Task context truncated (${raw.length} > 30000)`), raw.slice(0, 30000)) : raw;
          prompt = `[TASK CONTEXT — your notes from previous runs]\n${ctx}\n\n[TASK]\n${prompt}`;
        }
      }

      // #1610: a scheduled one-shot announce run's final response IS the
      // delivered payload. The contract is appended after task-file and
      // context composition, before dispatch, only for announce one-shots —
      // report and interactive-skill prompts stay unchanged.
      const deliveryContract = entry.interaction.mode === "oneshot" && entry.delivery === "announce";
      if (deliveryContract) {
        prompt = `${prompt}\n\n[DELIVERY CONTRACT]\nYour final response is automatically delivered to the target user when this run ends.\n- Return the requested user-facing content in your final response.\n- Do not return only a completion status, a saved-file path, or a summary of what was produced.\n- Do not call platform delivery tools to deliver the result yourself.\n- Saving a workspace copy is allowed but does not replace returning the content in your final response.`;
      }

      // #1432: scheduled interactive skill launch. The skill manager launches
      // or resumes K and returns the first model response; this runner stays
      // the sole owner of the announcement card, initial delivery, and
      // terminal scheduled settlement. Later user turns belong to K, never to
      // this run's history, retry, deadline, or settlement lifecycle.
      if (entry.interaction.mode === "skill") {
        advanceRun(taskId, runId, { phase: "executing", progressAt: factNow() });
        const { skillSessionManager } = await import("../skill-session.js");
        const launchResult = await skillSessionManager.launch({
          skill: entry.interaction.skill,
          agent: entry.agent,
          target: entry.interaction.target,
          message: prompt,
        });
        if (!launchResult.ok) {
          const detail = `skill ${entry.interaction.skill}: ${launchResult.error.message}`;
          logWarn(TAG, `Skill launch failed for task=${entry.id}: ${detail}`);
          settleRunOnce({
            entry, run: reservation, outcome: "definition_failed",
            diagnostic: makeTaskFailure("definition", "invalid_definition", "executing", detail, "permanent"),
            detail, cardId: undefined, factAt: factNow(),
          });
          return { status: "definition_failed", safeDetail: detail };
        }
        const boardId = kanbanEnqueue(formatTaskLabel(entry.id), "task", entry.id, {
          type: "K",
          delivery: "announce",
          chatId: entry.chatId ?? String(entry.interaction.target.chatId),
        });
        const detail = launchResult.response.slice(0, 200);
        settleRunOnce({ entry, run: reservation, outcome: "success", detail, cardId: boardId, executionRef: reservation.runId, onPaused: this.onPaused, onFailure: this.onFailure, factAt: factNow() });
        logTaskDebug("task_settled", { task: entry.id, run: reservation.runId }, `skill=${entry.interaction.skill} session=${launchResult.sessionId}`);
        return { status: "success", safeDetail: detail, cardId: boardId };
      }

      const execControl = this.executions.open({ executionRef: runId, type: "T" });
      // #1539: preparation/preflight precedes queued; successful dispatch
      // changes queued -> executing. Attaching IDs never moves phase backward.
      advanceRun(taskId, runId, { phase: "queued", attachments: { executionId: runId } });

      // #1432: every one-shot scheduled agent run is a T session. The `agent`
      // field selects runtime agent/model configuration only — it never maps
      // to A/B/C/D (the escaped regression where professor/browsie/coding/
      // dreamy contaminated persistent user/system sessions).
      const sessionType: import("../spin-types.js").SessionType = "T";

      const deadlineMs = reservation.deadlineAt - Date.now();
      const safeDeadline = Math.max(deadlineMs, 10_000);
      logTaskTrace("task_run_deadline_armed", { task: entry.id, run: reservation.runId }, `deadline_ms=${safeDeadline}`);

      let runner = this.agentRunner;
      if (!runner) {
        const { spin } = await import("../spin.js");
        runner = spin.dispatchAwait.bind(spin);
      }

      const commonRequest: import("../spin-types.js").SpinRequest = {
        timeoutMs: safeDeadline,
        type: sessionType,
        agent: entry.agent,
        title: formatTaskLabel(entry.id),
        goal: prompt,
        source: "task",
        priority: entry.priority ?? "MEDIUM",
        chatId: String(entry.chatId),
        maxToolRounds: entry.maxToolRounds,
        delivery: entry.delivery,
        settlementOwner: "caller",
        executionControl: execControl,
        executionScope,
        deadlineAt: reservation.deadlineAt,
        // #1520: scheduled cards stay delivery-locked until the shared settler
        // wins successful validation/settlement; release is idempotent.
        deliveryReady: false,
      };

      // #1516: branch only dispatch — the scheduled lifecycle (preflight,
      // deadline, validation, settlement, retry, delivery) stays shared.
      // Raw callers may pass unnormalized entries; absent orchestration means
      // the hard default of one agent (never fail an old-shaped task).
      const maxAgents = entry.orchestration?.maxAgents ?? 1;
      const executionPromise = maxAgents === 1
        ? runner(commonRequest)
        : this.resolveProjectRunner()({
          entryId: entry.id,
          runId,
          title: formatTaskLabel(entry.id),
          goal: prompt,
          priority: entry.priority ?? "medium",
          maxAgents,
          deadlineAt: reservation.deadlineAt,
          executionScope,
          executionControl: execControl,
          delivery: entry.delivery,
          chatId: String(entry.chatId),
          reportArtifactPath: resolvedContract?.artifactPath,
          laneDurationMs: entry.orchestration?.laneDurationMs,
        });

      // #1539: successful dispatch changes queued -> executing. Attaching the
      // card/session is separate and never moves the phase backward.
      advanceRun(taskId, runId, { phase: "executing", progressAt: factNow() });

      const raceResult = await runWithDeadline(
        executionPromise,
        safeDeadline,
        execControl,
        entry.id,
        runId,
        reservation.deadlineAt,
      );

      if (raceResult.kind === "timed_out") {
        logTaskTrace("task_run_deadline_fired", { task: entry.id, run: reservation.runId });
        settleRunOnce({
          entry, run: reservation, outcome: "timed_out",
          diagnostic: makeTaskFailure("interruption", "timed_out", "executing", raceResult.reason, "none"),
          detail: raceResult.reason, cardId: execControl.cardId, executionRef: runId, onPaused: this.onPaused, onFailure: this.onFailure,
        });
        return { status: "timed_out", safeDetail: raceResult.reason, ...(execControl.cardId !== undefined ? { cardId: execControl.cardId } : {}) };
      }

      if (raceResult.kind !== "completed") {
        const error = raceResult.error;
        const detail = error.message.slice(0, 1000);
        const cardId = error.cardId ?? execControl.cardId;
        // #1588: a typed supervision failure carries its own diagnostic —
        // never re-classified as execution/model_error.
        if (error instanceof SupervisedProjectFailure) {
          settleRunOnce({
            entry, run: reservation, outcome: "failed",
            diagnostic: error.diagnostic, detail: error.diagnostic.message,
            cardId, executionRef: runId, onPaused: this.onPaused, onFailure: this.onFailure, factAt: error.factAt ?? factNow(),
          });
          return { status: "failed", safeDetail: error.diagnostic.message, ...(cardId !== undefined ? { cardId } : {}) };
        }
        // #1520: a typed admission rejection (capacity/type-busy/cooldown)
        // before execution starts defers the SAME occurrence; anything after
        // a model call started is an execution failure and is counted.
        if (error instanceof SpinDispatchAdmissionError) {
          settleRunOnce({
            entry, run: reservation, outcome: "deferred",
            diagnostic: makeTaskFailure("admission", error.code, "queued", error.message, "transient"),
            detail: error.message, retryAt: error.retryAt, onPaused: this.onPaused, onFailure: this.onFailure,
          });
          logTaskDebug("task_admission_deferred", { task: entry.id }, `code=${error.code}`);
          return { status: "deferred", safeDetail: error.message };
        }
        // #1297: a typed terminal provider failure (credits_exhausted) maps to
        // its exact diagnostic with retryability none — no retry decision, no
        // retry timestamp. The failure policy then performs ordinary failed-run
        // settlement. Never classified as a transient model_error.
        if (isProviderExecutionError(error)) {
          const failure = error.failure;
          settleRunOnce({
            entry, run: reservation, outcome: "failed",
            diagnostic: makeTaskFailure("execution", failure.code, "executing", failure.message, "none"),
            detail: failure.message, cardId, executionRef: runId, onPaused: this.onPaused, onFailure: this.onFailure,
          });
          return { status: "failed", safeDetail: failure.message, ...(cardId !== undefined ? { cardId } : {}) };
        }
        // Structured transient classification: a stable error code (or an
        // explicit retryable flag) on the boundary error selects the policy's
        // one-delayed-retry branch; nothing is inferred from message text.
        const transient = isTransientProviderError(error);
        const errorFactAt = (error as Error & { factAt?: number }).factAt;
        settleRunOnce({
          entry, run: reservation, outcome: "failed",
          diagnostic: makeTaskFailure("execution", "model_error", "executing", detail, transient ? "transient" : "none"),
          detail, cardId, executionRef: runId, onPaused: this.onPaused, onFailure: this.onFailure, factAt: errorFactAt ?? factNow(),
        });
        return { status: "failed", safeDetail: detail, ...(cardId !== undefined ? { cardId } : {}) };
      }
      const { cardId: boardId, result: response, outcome } = raceResult.value;
      const childFactAt = raceResult.value.factAt ?? factNow();

      // #1539: only a durable OPERATOR cancellation settles as cancelled here.
      // A deadline request (our own race timer) is normalized by the settler
      // against the child fact's own time, so a pre-deadline fact must still
      // reach validation/settlement instead of being discarded as cancelled.
      const durableRequest = readState(taskId)?.activeRun?.terminalRequest;
      if (execControl.cancelled && durableRequest?.kind === "cancelled") {
        const reason = execControl.cancelReason ?? "cancelled";
        settleRunOnce({
          entry, run: reservation, outcome: "cancelled",
          diagnostic: makeTaskFailure("interruption", "cancelled", "cancelling", `cancelled: ${reason}`, "none"),
          detail: `cancelled: ${reason}`, cardId: boardId, executionRef: runId, onPaused: this.onPaused, onFailure: this.onFailure, factAt: childFactAt,
        });
        return { status: "cancelled", safeDetail: `cancelled: ${reason}`, cardId: boardId };
      }

      advanceRun(taskId, runId, { phase: "validating", progressAt: factNow() });
      logTaskTrace("task_validation_started", { task: entry.id, card: boardId, run: reservation.runId }, `report=${entry.delivery === "report"} response_bytes=${Buffer.byteLength(response ?? "", "utf8")}`);

      const isReport = entry.delivery === "report";
      let resultPath: string | null = null;
      let settlementDetail = "";

      if (isReport && resolvedContract) {
        const artifactResult = validateReportArtifact(
          resolvedContract.artifactPath,
          artifactBaseline,
          resolvedContract,
          reservation.reservedAt,
          entry.id,
        );
        if (artifactResult.ok) {
          resultPath = resolvedContract.artifactPath;
          settlementDetail = `artifact ${artifactResult.size} bytes`;
          // The shared settler is the exclusive delivery release point.
          settleRunOnce({
            entry, run: reservation, outcome: "success", detail: settlementDetail, resultPath, cardId: boardId,
            executionRef: runId, releaseDelivery: true, attachResult: maxAgents > 1, onPaused: this.onPaused, onFailure: this.onFailure, factAt: childFactAt,
          });
          return { status: "success", safeDetail: settlementDetail, artifactPath: resultPath ?? undefined, cardId: boardId };
        } else {
          settlementDetail = artifactResult.reason;
          settleRunOnce({
            entry, run: reservation, outcome: "failed",
            diagnostic: makeTaskFailure("validation", artifactResult.code, "validating", settlementDetail, "none"),
            detail: settlementDetail, cardId: boardId, executionRef: runId, onPaused: this.onPaused, onFailure: this.onFailure, factAt: factNow(),
          });
          return { status: "failed", safeDetail: settlementDetail, cardId: boardId };
        }
      } else if (isReport) {
        // Normalized report tasks always carry a contract. Keep this defensive
        // branch for direct queue callers so they fail before delivery rather
        // than falling back to response-length validation.
        settlementDetail = "report contract missing";
        // The shared settler owns card mutation; it fails the card exactly once.
        settleRunOnce({
          entry, run: reservation, outcome: "definition_failed",
          diagnostic: makeTaskFailure("definition", "report_contract_missing", "validating", settlementDetail, "permanent"),
          detail: settlementDetail, cardId: boardId, executionRef: runId, onPaused: this.onPaused, onFailure: this.onFailure, factAt: factNow(),
        });
        return { status: "definition_failed", safeDetail: settlementDetail, cardId: boardId };
      } else {
        // #1610: the one-shot announce final response is the user-facing
        // payload. deliveryText feeds the card's result_summary and delivery;
        // the short response prefix remains the operational detail.
        // #1651 v2: a single-agent announce succeeds only for real text
        // content. A reaction is a chat control signal, not a deliverable
        // payload; no-reply and empty are silent turns. Caller-owned
        // settlement fails closed with a structured empty_model_response
        // diagnostic — never `"completed"`, never a delivery release. A
        // report task never reaches this branch: its validated artifact owns
        // settlement above the text outcome. Multi-agent project lanes carry
        // no synthetic Spin outcome (accepted evidence owns them), so the
        // gate applies only to the single-agent contract. The direct runner
        // is required to return an outcome; an omitted outcome is therefore
        // a contract violation and must fail closed just like `empty`.
        // Multi-agent project results intentionally omit the Spin outcome and
        // are accepted here only after their evidence/artifact gates above.
        if (maxAgents === 1 && outcome !== "text") {
          const detail = outcome === "no_reply"
            ? "model signalled no reply"
            : outcome === "reaction"
              ? "model returned only a reaction"
              : outcome === "empty"
                ? "model returned no output"
                : "model result omitted its content outcome";
          logWarn(TAG, `Task ${entry.id}: announce turn produced no text (${outcome ?? "missing"}) — settling failed without delivery`);
          settleRunOnce({
            entry, run: reservation, outcome: "failed",
            diagnostic: makeTaskFailure("execution", "empty_model_response", "validating", detail, "none"),
            detail, cardId: boardId, executionRef: runId, onPaused: this.onPaused, onFailure: this.onFailure, factAt: childFactAt,
          });
          return { status: "failed", safeDetail: detail, cardId: boardId };
        }
        const settlementDetail = response.slice(0, 200);
        // The shared settler is the exclusive delivery release point.
        settleRunOnce({
          entry, run: reservation, outcome: "success", detail: settlementDetail,
          deliveryText: deliveryContract ? response : undefined, cardId: boardId,
          executionRef: runId, releaseDelivery: true, onPaused: this.onPaused, onFailure: this.onFailure, factAt: childFactAt,
        });
        return { status: "success", safeDetail: settlementDetail, cardId: boardId };
      }
    } catch (err) {
      // #1297: a typed terminal provider failure reaching the outer runner
      // guard keeps its exact diagnostic instead of degrading to model_error.
      if (isProviderExecutionError(err)) {
        const failure = err.failure;
        logWarn(TAG, `Runner error for task=${entry.id}: ${failure.message}`);
        settleRunOnce({
          entry, run: reservation, outcome: "failed",
          diagnostic: makeTaskFailure("execution", failure.code, "executing", failure.message, "none"),
          detail: failure.message, cardId: reservation.cardId, onPaused: this.onPaused, onFailure: this.onFailure, factAt: factNow(),
        });
        return { status: "failed", safeDetail: failure.message };
      }
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `Runner error for task=${entry.id}: ${msg}`);
      settleRunOnce({
        entry, run: reservation, outcome: "failed",
        diagnostic: makeTaskFailure("execution", "model_error", "executing", msg.slice(0, 500), "none"),
        detail: msg.slice(0, 500), cardId: reservation.cardId, onPaused: this.onPaused, onFailure: this.onFailure, factAt: factNow(),
      });
      return { status: "failed", safeDetail: msg.slice(0, 500) };
    } finally {
      this.executions.remove(reservation.runId);
      logTaskTrace("task_resources_released", { task: entry.id, exec: reservation.runId }, "control=removed");
    }
  }
}

/** #1520: structured transient classification — stable error codes only. */
const TRANSIENT_ERROR_CODES = new Set([
  "rate_limited",
  "provider_unavailable",
  "provider_error",
  "connection_error",
  "timeout",
  "tool_error",
  "agent_cap_reached",
]);

function isTransientProviderError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; retryable?: unknown };
  if (e.retryable === true) return true;
  return typeof e.code === "string" && TRANSIENT_ERROR_CODES.has(e.code);
}

type ExecutionRaceResult =
  | { kind: "completed"; value: { cardId: number; result: string; outcome?: import("../clean-response.js").ContentOutcome; factAt?: number } }
  | { kind: "failed"; error: Error & { cardId?: number } }
  | { kind: "timed_out"; reason: string };

async function runWithDeadline(
  promise: Promise<{ cardId: number; result: string; outcome?: import("../clean-response.js").ContentOutcome; factAt?: number }>,
  timeoutMs: number,
  execControl: ExecutionControl,
  taskId: string,
  runId: string,
  deadlineAt: number,
): Promise<ExecutionRaceResult> {
  return new Promise<ExecutionRaceResult>((resolve) => {
    const CANCEL_GRACE_MS = 5000;
    let finished = false;
    let deadlineWon = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ExecutionRaceResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (finished) return;
      deadlineWon = true;
      logTaskTrace("task_run_deadline_fired", { task: taskId, run: runId }, `timeout_ms=${timeoutMs}`);
      // #1539: the durable deadline request is recorded before signalling —
      // precedence never depends on callback order. The settler normalizes by
      // fact time: a child fact that predates the deadline still wins.
      requestRunTerminal(taskId, runId, { kind: "deadline_exceeded", requestedAt: Date.now(), reason: "deadline fired" });
      // #1506: Non-blocking cancellation — signal without awaiting acknowledgement.
      // The grace timer fires independently so settlement always proceeds.
      const cancellation = execControl.signalCancel("deadline");
      // Claim terminal ownership synchronously after signalling. This blocks a
      // provider that eventually resolves from running finishSpin/failSpin
      // against the already timed-out card and session.
      if (cancellation === "cancelled") execControl.markTerminal("timed_out");
      graceTimer = setTimeout(() => {
        finish({ kind: "timed_out", reason: `deadline fired after ${timeoutMs}ms` });
      }, CANCEL_GRACE_MS);
    }, timeoutMs);

    promise
      .then((value) => {
        // #1539: a terminal fact whose OWN time predates the deadline is
        // accepted even when observed after it — the settler decides by
        // factAt, so a late completion with a pre-deadline fact must not be
        // discarded. Facts without a factAt (or with a post-deadline one)
        // remain late once the deadline won.
        const lateFact = value.factAt !== undefined && Number.isFinite(value.factAt) && value.factAt < deadlineAt;
        if (!deadlineWon || lateFact) finish({ kind: "completed", value });
      })
      .catch((error: Error & { cardId?: number; factAt?: number }) => {
        const lateFact = error.factAt !== undefined && Number.isFinite(error.factAt) && error.factAt < deadlineAt;
        if (!deadlineWon || lateFact) finish({ kind: "failed", error });
      });
  });
}

async function getToolRegistry(): Promise<TaskToolRegistry | undefined> {
  // #1535: preflight verifies against the real tool registry. The earlier
  // pi-core-host/pi-core-tools branches looked for a getToolDescriptor export
  // that never existed, so any report task with requires.tools failed
  // preflight with "tool registry unavailable".
  try {
    const { getToolDescriptor } = await import("../transport/tool-registry.js");
    return { getToolDescriptor };
  } catch {
    return undefined;
  }
}
