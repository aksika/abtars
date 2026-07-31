import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { abtarsHome } from "../../paths.js";
import { logInfo, logWarn } from "../logger.js";
import { updateActiveRun } from "./task-state-store.js";
import { appendRun } from "./task-history-store.js";
import { preflightTask, validateReportArtifact } from "./task-preflight.js";
import { settleRunOnce } from "./task-run-settler.js";
import { createExecutionScope } from "./task-package.js";
import { registerControl, removeControl } from "../execution-control.js";
import { kanbanComplete, kanbanFail, kanbanAttachResult } from "./kanban-board.js";
import { logTaskDebug, logTaskTrace } from "./task-log-ctx.js";
import { incrementDeferrals, advanceNextRun } from "./task-state-store.js";
import { readLastPromptAt } from "../transport/bridge-lock-transport.js";
import type { ScheduledTask } from "./task-types.js";
import { formatTaskLabel } from "./task-types.js";
import type { ActiveTaskRun } from "./task-state-store.js";
import type { ResolvedReportContract, ArtifactBaseline } from "./task-preflight.js";

const TAG = "scheduled-task-runner";
const MAX_IDLE_DEFERRALS = 5;

export interface ScheduledTaskRunOutcome {
  status: "success" | "definition_failed" | "failed" | "timed_out" | "cancelled" | "deferred";
  safeDetail?: string;
  artifactPath?: string;
  cardId?: number;
}

export type AgentTaskRunner = (request: import("../spin-types.js").SpinRequest) => Promise<{ cardId: number; result: string }>;
export type TaskPausedCallback = (chatId: number, title: string, reason: string) => void;
export type FailInjectCallback = (entryId: string, command: string, result: string) => void;
export type { ScheduledProjectRequest, ScheduledProjectRunner } from "./scheduled-project-runner.js";

export class ScheduledTaskRunner {
  private readonly agentRunner?: AgentTaskRunner;
  private readonly projectRunner?: import("./scheduled-project-runner.js").ScheduledProjectRunner;

  constructor(opts?: { agentRunner?: AgentTaskRunner; onTaskPaused?: TaskPausedCallback; onFailInject?: FailInjectCallback; projectRunner?: import("./scheduled-project-runner.js").ScheduledProjectRunner }) {
    this.agentRunner = opts?.agentRunner;
    this.projectRunner = opts?.projectRunner;
  }

  private resolveProjectRunner(): import("./scheduled-project-runner.js").ScheduledProjectRunner {
    if (this.projectRunner) return this.projectRunner;
    const { scheduledProjectRunner } = require("./scheduled-project-runner.js") as typeof import("./scheduled-project-runner.js");
    return scheduledProjectRunner;
  }

  async run(entry: ScheduledTask & { kind: "agent" }, reservation: ActiveTaskRun): Promise<ScheduledTaskRunOutcome> {
    logTaskDebug("task_execution_started", { task: entry.id, run: reservation.runId, attempt: reservation.attempt });
    updateActiveRun(entry.id, reservation.runId, { phase: "executing" });

    try {
      if (!reservation.trigger || reservation.trigger === "schedule") {
        const idleMs = Date.now() - readLastPromptAt();
        if (idleMs < 90_000) {
          logInfo(TAG, `Deferring agent task "${entry.id}" — user active ${Math.round(idleMs / 1000)}s ago`);
          const count = incrementDeferrals(entry.id);
          if (count >= MAX_IDLE_DEFERRALS) {
            logWarn(TAG, `Idle gate exhausted for "${entry.id}" after ${count} deferrals — running despite active user`);
            logTaskDebug("task_deferred_budget_exhausted", { task: entry.id }, `deferrals=${count}`);
          } else {
            const deferredAt = Date.now();
            appendRun({ taskId: entry.id, kind: entry.kind, trigger: "schedule", startedAt: deferredAt, finishedAt: deferredAt, outcome: "deferred", detail: `idle_gate:user_active deferrals=${count}`, runId: reservation.runId, groupId: reservation.groupId });
            logTaskDebug("task_deferred", { task: entry.id }, `reason=idle_gate deferrals=${count}`);
            advanceNextRun(entry.id, entry.schedule);
            return { status: "deferred", safeDetail: `idle_gate deferrals=${count}` };
          }
        }
      }

      let prompt = entry.prompt ?? "";
      let resolvedContract: ResolvedReportContract | undefined;
      let artifactBaseline: ArtifactBaseline | undefined;

      if (entry.taskFile) {
        updateActiveRun(entry.id, reservation.runId, { phase: "preflight" });
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
        updateActiveRun(entry.id, reservation.runId, { phase: "preflight" });
        logTaskTrace("task_preflight_started", { task: entry.id, run: reservation.runId });
        const preflight = preflightTask(entry, executionScope, toolRegistry);
        if (!preflight.ok) {
          logTaskTrace("task_preflight_failed", { task: entry.id }, `code=${preflight.code}`);
          settleRunOnce({ entry, run: reservation, outcome: "definition_failed", detail: preflight.safeDetail, cardId: undefined });
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

      const runId = reservation.runId;
      const execControl = registerControl(runId, { cardId: undefined });
      updateActiveRun(entry.id, reservation.runId, { phase: "queued", executionId: runId });

      const AGENT_SESSION: Record<string, string> = { professor: "A", browsie: "B", coding: "C", dreamy: "D" };
      const sessionType = (AGENT_SESSION[entry.agent] ?? "T") as import("../spin-types.js").SessionType;

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
        });

      const raceResult = await runWithDeadline(
        executionPromise,
        safeDeadline,
        execControl,
        entry.id,
        runId,
      );

      if (raceResult.kind === "timed_out") {
        logTaskTrace("task_run_deadline_fired", { task: entry.id, run: reservation.runId });
        settleRunOnce({ entry, run: reservation, outcome: "timed_out", detail: raceResult.reason, cardId: execControl.cardId, executionRef: runId });
        return { status: "timed_out", safeDetail: raceResult.reason, ...(execControl.cardId !== undefined ? { cardId: execControl.cardId } : {}) };
      }

      if (execControl.cancelled) {
        const reason = execControl.cancelReason ?? "cancelled";
        settleRunOnce({ entry, run: reservation, outcome: "cancelled", detail: `cancelled: ${reason}`, executionRef: runId });
        return { status: "cancelled", safeDetail: `cancelled: ${reason}` };
      }

      if (raceResult.kind !== "completed") {
        const error = raceResult.error;
        const detail = error.message.slice(0, 1000);
        const cardId = error.cardId ?? execControl.cardId;
        settleRunOnce({
          entry,
          run: reservation,
          outcome: "failed",
          detail,
          cardId,
          executionRef: runId,
        });
        return { status: "failed", safeDetail: detail, ...(cardId !== undefined ? { cardId } : {}) };
      }
      const { cardId: boardId, result: response } = raceResult.value;

      updateActiveRun(entry.id, reservation.runId, { phase: "validating" });
      logTaskTrace("task_validation_started", { task: entry.id, card: boardId, run: reservation.runId }, `report=${entry.delivery === "report"} response_bytes=${Buffer.byteLength(response ?? "", "utf8")}`);

      if (execControl.cancelled) {
        const reason = execControl.cancelReason ?? "cancelled";
        settleRunOnce({ entry, run: reservation, outcome: "cancelled", detail: `cancelled: ${reason}`, cardId: boardId, executionRef: runId });
        return { status: "cancelled", safeDetail: `cancelled: ${reason}`, cardId: boardId };
      }

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
          if (maxAgents > 1) {
            // Project acceptance already marked the root card done; attach the
            // validated artifact without re-triggering settlement.
            kanbanAttachResult(boardId, resultPath, settlementDetail);
          } else {
            kanbanComplete(boardId, resultPath, settlementDetail);
          }
          settleRunOnce({ entry, run: reservation, outcome: "success", detail: settlementDetail, resultPath, cardId: boardId, executionRef: runId });
          return { status: "success", safeDetail: settlementDetail, artifactPath: resultPath ?? undefined, cardId: boardId };
        } else {
          settlementDetail = artifactResult.reason;
          settleRunOnce({ entry, run: reservation, outcome: "failed", detail: settlementDetail, cardId: boardId, executionRef: runId });
          return { status: "failed", safeDetail: settlementDetail, cardId: boardId };
        }
      } else if (isReport) {
        // Normalized report tasks always carry a contract. Keep this defensive
        // branch for direct queue callers so they fail before delivery rather
        // than falling back to response-length validation.
        settlementDetail = "report contract missing";
        kanbanFail(boardId, settlementDetail);
        settleRunOnce({ entry, run: reservation, outcome: "definition_failed", detail: settlementDetail, cardId: boardId, executionRef: runId });
        return { status: "definition_failed", safeDetail: settlementDetail, cardId: boardId };
      } else {
        kanbanComplete(boardId, null, response?.slice(0, 4000) || "completed");
        settleRunOnce({ entry, run: reservation, outcome: "success", detail: response?.slice(0, 200), cardId: boardId, executionRef: runId });
        return { status: "success", safeDetail: response?.slice(0, 200), cardId: boardId };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `Runner error for task=${entry.id}: ${msg}`);
      settleRunOnce({ entry, run: reservation, outcome: "cancelled", detail: msg, cardId: reservation.cardId });
      return { status: "cancelled", safeDetail: msg };
    } finally {
      removeControl(reservation.runId);
      logTaskTrace("task_resources_released", { task: entry.id, exec: reservation.runId }, "control=removed");
    }
  }
}

type ExecutionRaceResult =
  | { kind: "completed"; value: { cardId: number; result: string } }
  | { kind: "failed"; error: Error & { cardId?: number } }
  | { kind: "timed_out"; reason: string };

async function runWithDeadline(
  promise: Promise<{ cardId: number; result: string }>,
  timeoutMs: number,
  execControl: ReturnType<typeof registerControl>,
  taskId: string,
  runId: string,
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
      updateActiveRun(taskId, runId, { phase: "cancelling" });
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
        // Once the deadline callback has run, the result is late even if the
        // transport happens to resolve during the cancellation grace period.
        if (!deadlineWon) finish({ kind: "completed", value });
      })
      .catch((error: Error & { cardId?: number }) => {
        if (!deadlineWon) finish({ kind: "failed", error });
      });
  });
}

async function getToolRegistry(): Promise<{ getToolDescriptor: (name: string) => { processDependency?: { executable: string; probeArgs: string[] } } | undefined } | undefined> {
  try {
    const piHost = await import("../transport/pi-core-host.js");
    if (piHost && typeof (piHost as any).getToolDescriptor === "function") {
      return piHost as any;
    }
    const tools = await import("../transport/pi-core-tools.js");
    if (tools && typeof (tools as any).getToolDescriptor === "function") {
      return tools as any;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
