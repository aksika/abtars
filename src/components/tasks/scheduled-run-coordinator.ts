/**
 * scheduled-run-coordinator.ts — #1539: the durable scheduled-run lifecycle
 * owner. The coordinator owns admission dispatch, child attachment, deadline
 * and cancellation requests, restart recovery, and terminal normalization for
 * every executable scheduled or manual occurrence. CronQueue orders admission
 * only; the coordinator never makes lane liveness depend on an adapter
 * promise resolving.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { nerve } from "../nerve.js";
import { logInfo, logWarn } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { logTaskDebug, logTaskTrace } from "./task-log-ctx.js";
import { getSystemTaskRegistry } from "./system-task-registry.js";
import { ScheduledTaskRunner, type AgentTaskRunner, type TaskFailureCallback, type TaskPausedCallback } from "./scheduled-task-runner.js";
import { settleRunFromHistory, settleRunOnce, onRunTerminal } from "./task-run-settler.js";
import { settleExpiredRun } from "./due-sources.js";
import { makeTaskFailure } from "./task-failure.js";
import { addTaskFailure } from "./task-failure-buffer.js";
import { advanceRun, readState, requestRunTerminal, getRunOwner } from "./task-state-store.js";
import { ownerIsLive } from "./run-liveness.js";
import { getRun } from "./task-history-store.js";
import { kanbanGetCard, resolveRootId } from "./kanban-board.js";
import type { ExecutionSupervisor } from "../execution-control.js";
import { spin as spinFacade } from "../spin.js";
import { isSystemEntry, formatTaskLabel } from "./task-types.js";
import type { ScheduledTask } from "./task-types.js";
import type { ActiveTaskRun } from "./task-state-store.js";
import type { TaskFailureDiagnosticV1 } from "./task-failure.js";

const TAG = "run-coordinator";
const SCRIPT_KILL_FALLBACK_MS = 5000;
const SCRIPT_PROGRESS_THROTTLE_MS = 30_000;

export type RunLane = "manual" | "scheduled";

/** #1517 port: the coordinator is the live owner of active runs. */
export interface ActiveRunSupervisor {
  owns(runId: string): boolean;
  cancel(runId: string, reason: string): "requested" | "not_owned";
}

export interface ScheduledRunView {
  runId: string;
  taskId: string;
  lane: RunLane;
  kind: "script" | "agent" | "system";
  phase: ActiveTaskRun["phase"];
  startedAt: number;
  deadlineAt: number;
  lastProgressAt: number;
  cardId?: number;
  sessionId?: string;
  executionId?: string;
  terminalRequest?: ActiveTaskRun["terminalRequest"];
}

interface CoordinatorHandle {
  taskId: string;
  entry: ScheduledTask;
  run: ActiveTaskRun;
  lane: RunLane;
  kind: "script" | "agent" | "system";
  child?: ChildProcess;
  killTimers: Set<ReturnType<typeof setTimeout>>;
  lastProgressAt: number;
  abort?: AbortController;
}

export type FollowUpEnqueue = (entry: ScheduledTask) => void;

export class ScheduledRunCoordinator implements ActiveRunSupervisor {
  private readonly handles = new Map<string, CoordinatorHandle>();
  private readonly taskRunner: ScheduledTaskRunner;
  private readonly onFailure?: TaskFailureCallback;
  private readonly executions: ExecutionSupervisor;
  private followUpEnqueue?: FollowUpEnqueue;
  private laneReleaseListener: (() => void) | null = null;

  constructor(opts?: {
    onFailure?: TaskFailureCallback;
    onTaskPaused?: TaskPausedCallback;
    agentRunner?: AgentTaskRunner;
    projectRunner?: import("./scheduled-project-runner.js").ScheduledProjectRunner;
    onLaneRelease?: () => void;
    executions?: ExecutionSupervisor;
  }) {
    this.onFailure = opts?.onFailure;
    // #1540: the single shared live supervisor (Spin's own instance by default).
    this.executions = opts?.executions ?? spinFacade.executionSupervisor;
    this.taskRunner = new ScheduledTaskRunner({
      agentRunner: opts?.agentRunner,
      onTaskPaused: opts?.onTaskPaused,
      onFailure: opts?.onFailure,
      projectRunner: opts?.projectRunner,
      executions: this.executions,
    });
    this.laneReleaseListener = opts?.onLaneRelease ?? null;
    onRunTerminal((_taskId, runId) => {
      const handle = this.handles.get(runId);
      if (handle) this.releaseHandle(handle);
      this.laneReleaseListener?.();
    });
  }

  /** The queue wires follow-up admission (script gate triggers) here. */
  setFollowUpEnqueue(fn: FollowUpEnqueue | undefined): void {
    this.followUpEnqueue = fn;
  }

  setLaneReleaseListener(fn: (() => void) | null): void {
    this.laneReleaseListener = fn;
  }

  /** #1588: the failure cascade callback, exposed for shared settlement paths. */
  get failureCallback(): TaskFailureCallback | undefined {
    return this.onFailure;
  }

  /**
   * Start exactly one adapter for the reserved occurrence. Returns "stale"
   * when the reservation no longer belongs to this run. Never awaited by the
   * queue: lane release is driven by the durable terminal event.
   *
   * #1539 R4: script/system runs advance queued -> executing here (the agent
   * runner owns its own preparation -> queued -> executing ordering).
   */
  start(entry: ScheduledTask, run: ActiveTaskRun, lane: RunLane): "started" | "stale" {
    const state = readState(entry.id);
    if (!state?.activeRun || state.activeRun.runId !== run.runId) return "stale";

    if (isSystemEntry(entry)) {
      advanceRun(entry.id, run.runId, { phase: "queued" });
      const handle = this.makeHandle(entry, run, lane, "system");
      logTaskDebug("run_started", { task: entry.id, run: run.runId }, `lane=${lane} kind=system`);
      this.dispatchSystem(handle);
      return "started";
    }
    if (entry.kind === "script") {
      advanceRun(entry.id, run.runId, { phase: "queued" });
      const handle = this.makeHandle(entry, run, lane, "script");
      logTaskDebug("run_started", { task: entry.id, run: run.runId }, `lane=${lane} kind=script`);
      this.runScript(handle);
      return "started";
    }
    const handle = this.makeHandle(entry, run, lane, "agent");
    logTaskDebug("run_started", { task: entry.id, run: run.runId }, `lane=${lane} kind=agent`);
    void this.runAgent(handle);
    return "started";
  }

  owns(runId: string): boolean {
    return this.handles.has(runId);
  }

  /**
   * #1539: user/operator cancellation. Records the durable cancellation
   * request BEFORE signalling the child, so precedence never depends on
   * callback order. Script children are terminated through the safe process
   * handle with a bounded SIGKILL fallback; agent runs signal the registered
   * execution control; system dispatches have no cancel handle and settle via
   * the cancellation grace item.
   */
  cancel(runId: string, reason: string): "requested" | "not_owned" {
    const handle = this.handles.get(runId);
    if (!handle) return "not_owned";
    requestRunTerminal(handle.taskId, runId, { kind: "cancelled", requestedAt: Date.now(), reason });
    logTaskDebug("run_terminal_requested", { task: handle.taskId, run: runId }, `kind=cancelled reason=${reason.slice(0, 60)}`);
    this.signalTerminal(handle, reason);
    return "requested";
  }

  /**
   * #1539: deadline wake entry from the run-deadline due source. Records the
   * durable deadline request first; a child terminal fact whose own time
   * precedes the deadline still wins in the settler.
   */
  deadlineExpired(taskId: string, runId: string, reason: string): void {
    requestRunTerminal(taskId, runId, { kind: "deadline_exceeded", requestedAt: Date.now(), reason });
    logTaskDebug("run_terminal_requested", { task: taskId, run: runId }, `kind=deadline_exceeded reason=${reason.slice(0, 60)}`);
    const handle = this.handles.get(runId);
    if (handle) {
      this.progress(handle);
      this.signalTerminal(handle, reason);
    }
  }

  /**
   * #1539: authoritative restart recovery — the migration of
   * task-checker.reconcileActiveTaskRuns. Precedence: history repair,
   * terminal project/card evidence (adopts the project's actual outcome),
   * expired-run settlement, O reattach, then uncertain interruption.
   */
  async recover(entries: ScheduledTask[], reattachProject?: (entry: ScheduledTask, run: ActiveTaskRun) => boolean): Promise<void> {
    for (const entry of entries) {
      const state = readState(entry.id);
      if (!state?.activeRun) continue;

      const run = state.activeRun;
      const terminalHistory = getRun(run.runId);
      if (terminalHistory) {
        if (settleRunFromHistory(entry, run, terminalHistory)) {
          logInfo(TAG, `recovery: task=${entry.id} run=${run.runId} repaired_from_history`);
        }
        continue;
      }

      // Terminal project evidence first: adopt the project's actual outcome.
      if (run.cardId !== undefined) {
        const card = kanbanGetCard(run.cardId);
        if (card && card.status === "done") {
          settleRunOnce({
            entry, run, outcome: "success",
            detail: `restart_recovery: project terminal (${card.status})`,
            resultPath: card.result_path ?? undefined,
            cardId: run.cardId,
            releaseDelivery: true,
            attachResult: Boolean(card.result_path && entry.kind === "agent" && (entry.orchestration?.maxAgents ?? 1) > 1),
          });
          logInfo(TAG, `recovery: task=${entry.id} run=${run.runId} adopted project success card=${run.cardId}`);
          continue;
        }
        if (card && (card.status === "delivered" || card.status === "failed")) {
          const delivered = card.status === "delivered";
          settleRunOnce({
            entry, run, outcome: delivered ? "success" : "failed",
            diagnostic: delivered ? undefined : makeTaskFailure("interruption", "restart_interrupted", "executing",
              `restart recovery: project terminal (${card.status})`, "none"),
            detail: delivered ? `restart_recovery: project delivered` : `restart_recovery: project terminal (${card.status})`,
            resultPath: card.result_path ?? undefined,
            cardId: run.cardId,
            releaseDelivery: delivered,
            attachResult: Boolean(card.result_path && delivered && entry.kind === "agent" && (entry.orchestration?.maxAgents ?? 1) > 1),
            onFailure: this.onFailure,
          });
          logInfo(TAG, `recovery: task=${entry.id} run=${run.runId} adopted project ${card.status} card=${run.cardId}`);
          continue;
        }
      }

      if (run.deadlineAt < Date.now()) {
        settleExpiredRun(entry, run, "restart_recovery: deadline passed", "restart_recovery: scheduled deadline passed", this.onFailure);
        logInfo(TAG, `recovery: task=${entry.id} run=${run.runId} settled_deadline_passed`);
        continue;
      }

      // Unexpired non-terminal O project: reattach under the same run ID.
      if (run.cardId !== undefined && entry.kind === "agent" && (entry.orchestration?.maxAgents ?? 1) > 1 && reattachProject) {
        if (reattachProject(entry, run)) {
          logInfo(TAG, `recovery: task=${entry.id} run=${run.runId} reattached_project card=${run.cardId}`);
          continue;
        }
        logWarn(TAG, `recovery: unable to reattach scheduled project task=${entry.id} run=${run.runId} card=${run.cardId}`);
      }

      // Uncertain T/script/system execution: never replayed, never guessed.
      // #1601: a provably-dead owner settles `unknown` — the run's side
      // effects may have completed. An unprovable (e.g. migrated) or still
      // live owner is left untouched; the run-deadline source eventually
      // terminates it on durable evidence instead of a guess.
      const owner = getRunOwner(run.runId);
      if (owner && !ownerIsLive(owner.pid, owner.startedAt)) {
        settleRunOnce({
          entry, run, outcome: "unknown",
          diagnostic: makeTaskFailure("interruption", "owner_lost", "executing",
            "Owner process exited before a durable terminal state; whether this run's side effects completed is unknown.", "transient"),
          detail: "restart_recovery: owner process gone, side effects unknown",
        });
        logInfo(TAG, `recovery: task=${entry.id} run=${run.runId} settled_unknown (owner ${owner.pid} provably dead)`);
        continue;
      }
      logWarn(TAG, `recovery: task=${entry.id} run=${run.runId} owner liveness unprovable or live — left untouched (deadline source owns it)`);
    }
  }

  describe(): ScheduledRunView[] {
    const views: ScheduledRunView[] = [];
    for (const handle of this.handles.values()) {
      const state = readState(handle.taskId);
      const run = state?.activeRun;
      if (!run || run.runId !== handle.run.runId) continue;
      views.push({
        runId: run.runId,
        taskId: handle.taskId,
        lane: handle.lane,
        kind: handle.kind,
        phase: run.phase,
        startedAt: run.reservedAt,
        deadlineAt: run.deadlineAt,
        lastProgressAt: run.lastProgressAt,
        cardId: run.cardId,
        sessionId: run.sessionId,
        executionId: run.executionId,
        terminalRequest: run.terminalRequest,
      });
    }
    return views;
  }

  /**
   * #1539: meaningful card/attempt transitions project into run progress.
   * Worker cards (source "agent") resolve to their root O card, which carries
   * the scheduled run identity (source_id = runId). Progress is bounded by
   * card-transition volume; liveness-only events never rewrite task state.
   */
  projectCardProgress(cardId: number): void {
    let runCard = kanbanGetCard(cardId);
    if (!runCard) return;
    const rootId = resolveRootId(cardId);
    if (rootId !== undefined && rootId !== cardId) {
      const root = kanbanGetCard(rootId);
      if (root) runCard = root;
    }
    if (runCard.source !== "task" || !runCard.source_id) return;
    const handle = this.handles.get(runCard.source_id);
    if (!handle) return;
    const now = Date.now();
    advanceRun(handle.taskId, handle.run.runId, { progressAt: now });
    logTaskTrace("run_progress", { task: handle.taskId, run: handle.run.runId }, `card=${cardId} root=${runCard.id}`);
  }

  private makeHandle(entry: ScheduledTask, run: ActiveTaskRun, lane: RunLane, kind: CoordinatorHandle["kind"]): CoordinatorHandle {
    const handle: CoordinatorHandle = {
      taskId: entry.id,
      entry,
      run,
      lane,
      kind,
      killTimers: new Set(),
      lastProgressAt: Date.now(),
    };
    this.handles.set(run.runId, handle);
    return handle;
  }

  private releaseHandle(handle: CoordinatorHandle): void {
    if (handle.kind === "script" && handle.child) {
      const child = handle.child;
      child.removeAllListeners("exit");
      child.removeAllListeners("error");
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
    }
    for (const timer of handle.killTimers) clearTimeout(timer);
    handle.killTimers.clear();
    if (this.handles.get(handle.run.runId) === handle) {
      this.handles.delete(handle.run.runId);
    }
  }

  private signalTerminal(handle: CoordinatorHandle, reason: string): void {
    if (handle.kind === "script" && handle.child) {
      const child = handle.child;
      if (child.exitCode === null) {
        try {
          child.kill("SIGTERM");
        } catch { /* best effort */ }
        const killTimer = setTimeout(() => {
          handle.killTimers.delete(killTimer);
          if (handle.child !== child || child.exitCode !== null) return;
          try {
            child.kill("SIGKILL");
          } catch { /* best effort */ }
        }, SCRIPT_KILL_FALLBACK_MS);
        handle.killTimers.add(killTimer);
      }
      return;
    }
    if (handle.kind === "agent") {
      const control = this.executions.get(handle.run.runId);
      if (control) control.signalCancel(reason as import("../swarm-executor-types.js").CancelReason);
      return;
    }
    // system dispatch: signal the handler's cooperative cancellation context;
    // the cancellation-grace fallback in due-sources.ts remains the backstop
    // for a handler that ignores the signal.
    handle.abort?.abort(new Error(reason));
  }

  private dispatchSystem(handle: CoordinatorHandle): void {
    const entry = handle.entry as ScheduledTask & { kind: "system" };
    const run = handle.run;
    const startedAt = Date.now();
    advanceRun(handle.taskId, run.runId, { phase: "executing", progressAt: startedAt });
    void (async () => {
      try {
        // #1603: the handler may await a long action (e.g. a sleep cycle).
        // Progress must roll the rolling inactivity limit forward or the
        // run-deadline source settles the run while it is still healthy.
        const abort = new AbortController();
        handle.abort = abort;
        const ctx = {
          progress: () => this.throttledProgress(handle),
          signal: abort.signal,
        };
        const result = await getSystemTaskRegistry().dispatch(entry, ctx);
        const factAt = Date.now();
        if (result.status === "deferred") {
          settleRunOnce({
            entry, run, outcome: "deferred",
            diagnostic: makeTaskFailure("admission", "executor_unavailable", "queued", result.detail, "transient"),
            detail: result.detail,
            retryAt: result.retryAt,
            factAt,
          });
          logInfo(TAG, `Deferred: "${entry.action}" (${entry.id}) — retry at ${new Date(result.retryAt).toISOString()}: ${result.detail}`);
        } else if (result.status === "noop") {
          settleRunOnce({ entry, run, outcome: "noop", detail: result.detail, factAt });
          logInfo(TAG, `System noop: "${entry.action}" (${entry.id})${result.detail ? ` — ${result.detail}` : ""}`);
        } else if (result.status === "ok") {
          settleRunOnce({ entry, run, outcome: "success", detail: result.detail, factAt });
          logInfo(TAG, `System ok: "${entry.action}" (${entry.id})${result.detail ? ` — ${result.detail}` : ""}`);
        } else {
          settleRunOnce({
            entry, run, outcome: "failed",
            diagnostic: makeTaskFailure("execution", "process_exit", "executing", result.error, "none"),
            detail: result.error,
            factAt,
            onFailure: this.onFailure,
          });
          logInfo(TAG, `System fail: "${entry.action}" (${entry.id}) — ${result.error}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn(TAG, `System dispatch error for "${entry.action}": ${msg}`);
        settleRunOnce({
          entry, run, outcome: "failed",
          diagnostic: makeTaskFailure("execution", "process_exit", "executing", msg, "none"),
          detail: msg,
          factAt: Date.now(),
          onFailure: this.onFailure,
        });
      }
    })();
  }

  private runScript(handle: CoordinatorHandle): void {
    const entry = handle.entry as ScheduledTask & { kind: "script" };
    const run = handle.run;
    const runId = run.runId;
    logInfo(TAG, `Script: "${entry.command}" (${entry.id}) run=${runId}`);
    try {
      const child = spawn("bash", ["-c", entry.command], { stdio: ["ignore", "pipe", "pipe"] });
      handle.child = child;
      // #1539 R4: successful spawn changes queued -> executing.
      advanceRun(handle.taskId, runId, { phase: "executing", progressAt: Date.now() });
      this.progress(handle);

      let output = "";
      let settled = false;

      const settleAndCleanup = (opts: Parameters<typeof settleRunOnce>[0]): void => {
        if (settled) return;
        settled = true;
        settleRunOnce(opts);
        this.releaseHandle(handle);
      };

      child.stdout?.on("data", (d: Buffer) => {
        output += d.toString();
        this.throttledProgress(handle);
      });
      child.stderr?.on("data", (d: Buffer) => {
        output += d.toString();
        this.throttledProgress(handle);
      });

      child.on("exit", (code) => {
        if (settled) return;
        const finishedAt = Date.now();
        const ok = code === 0;
        const diagnostic: TaskFailureDiagnosticV1 = ok
          ? makeTaskFailure("execution", "process_exit", "executing", "script exited 0", "none")
          : makeTaskFailure("execution", "process_exit", "executing", `script exited ${code}`, "none");
        settleAndCleanup({
          entry, run, outcome: ok ? "success" : "failed", diagnostic,
          detail: (output || `exit ${code}`).slice(0, 500),
          factAt: finishedAt,
          onFailure: this.onFailure,
        });
        const followUp = entry.followUp;
        if (ok && output.trim() && followUp) {
          logInfo(TAG, `Gate triggered → enqueuing agent follow-up for "${entry.id}"`);
          const agentPrompt = followUp.prompt.replace("{{GATE_OUTPUT}}", output.trim());
          const followUpAgent = followUp.agent && ["task", "professor", "browsie", "coding", "dreamy"].includes(followUp.agent)
            ? followUp.agent as "task" | "professor" | "browsie" | "coding" | "dreamy"
            : "task";
          const agentEntry: ScheduledTask = {
            id: entry.id + "-followup",
            enabled: true,
            priority: "medium",
            delivery: "silent",
            kind: "agent",
            prompt: agentPrompt,
            agent: followUpAgent,
            interaction: { mode: "oneshot" },
            orchestration: { maxAgents: 1 },
          };
          this.followUpEnqueue?.(agentEntry);
        }
        if (!ok) {
          addTaskFailure({ taskName: formatTaskLabel(entry.id), exitCode: code ?? 1, error: (output || "").slice(0, 100), timestamp: finishedAt, consecutiveFailures: 1 });
        }
      });

      child.on("error", (err) => {
        logWarn(TAG, `Script spawn failed for task=${entry.id} (error_chars=${err.message.length})`);
        settleAndCleanup({
          entry, run, outcome: "failed",
          diagnostic: makeTaskFailure("dependency", "executable_missing", "preflight", `spawn failed: ${err.message.slice(0, 200)}`, "permanent"),
          detail: err.message.slice(0, 500),
          factAt: Date.now(),
          onFailure: this.onFailure,
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `Script error for task=${entry.id} (error_chars=${message.length})`);
      settleRunOnce({
        entry, run, outcome: "failed",
        diagnostic: makeTaskFailure("dependency", "executable_missing", "preflight", message.slice(0, 200), "permanent"),
        detail: message.slice(0, 500),
        factAt: Date.now(),
        onFailure: this.onFailure,
      });
      this.releaseHandle(handle);
    }
  }

  private async runAgent(handle: CoordinatorHandle): Promise<void> {
    const entry = handle.entry as ScheduledTask & { kind: "agent" };
    const run = handle.run;
    try {
      const outcome = await this.taskRunner.run(entry, run);
      logTaskDebug("task_settled", { task: entry.id, run: run.runId }, `outcome=${outcome.status}`);
      // Defensive offer: the runner settles before returning, so this is
      // normally a duplicate/late no-op. It guarantees an adapter that
      // returns without settling still completes its occurrence once.
      if (outcome.status === "success") {
        settleRunOnce({
          entry, run, outcome: "success", detail: outcome.safeDetail,
          cardId: outcome.cardId, resultPath: outcome.artifactPath,
          releaseDelivery: true, factAt: Date.now(),
        });
      } else {
        const diagnostic = outcome.status === "definition_failed"
          ? makeTaskFailure("definition", "invalid_definition", "settling", outcome.safeDetail ?? "adapter failed", "permanent")
          : makeTaskFailure("execution", "model_error", "settling", outcome.safeDetail ?? "adapter failed", "none");
        settleRunOnce({
          entry, run, outcome: outcome.status === "timed_out" ? "timed_out" : outcome.status,
          diagnostic, detail: outcome.safeDetail, cardId: outcome.cardId, factAt: Date.now(),
          onFailure: this.onFailure,
        });
      }
    } catch (err) {
      logWarn(TAG, `runAgent error for "${entry.id}": ${err instanceof Error ? err.message : String(err)}`);
      const msg = err instanceof Error ? err.message : String(err);
      settleRunOnce({
        entry, run, outcome: "failed",
        diagnostic: makeTaskFailure("execution", "model_error", "executing", msg.slice(0, 500), "none"),
        detail: msg.slice(0, 500),
        factAt: Date.now(),
        onFailure: this.onFailure,
      });
    }
  }

  private progress(handle: CoordinatorHandle): void {
    const now = Date.now();
    handle.lastProgressAt = now;
    const result = advanceRun(handle.taskId, handle.run.runId, { progressAt: now });
    if (result !== "regression") {
      logTaskTrace("run_progress", { task: handle.taskId, run: handle.run.runId }, `kind=${handle.kind}`);
    }
  }

  private throttledProgress(handle: CoordinatorHandle): void {
    const now = Date.now();
    if (now - handle.lastProgressAt < SCRIPT_PROGRESS_THROTTLE_MS) return;
    this.progress(handle);
  }
}

/**
 * #1539: card/attempt transitions project into the owning occurrence's durable
 * progress. Wired once per process; listens for task-source card events.
 */
export function wireCardProgressProjection(coordinator: ScheduledRunCoordinator): () => void {
  const onCard = (cardId: number): void => {
    try {
      coordinator.projectCardProgress(cardId);
    } catch (err) {
      logAndSwallow(TAG, "projectCardProgress", err);
    }
  };
  nerve.on("card:queued", onCard);
  nerve.on("card:running", onCard);
  nerve.on("card:done", onCard);
  nerve.on("card:failed", onCard);
  return () => {
    nerve.off("card:queued", onCard);
    nerve.off("card:running", onCard);
    nerve.off("card:done", onCard);
    nerve.off("card:failed", onCard);
  };
}
