import { logAndSwallow } from "../log-and-swallow.js";
import { addTaskFailure } from "./task-failure-buffer.js";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logInfo, logWarn } from "../logger.js";
import { createRunId, reserveRun, readState } from "./task-state-store.js";
import { logTaskDebug } from "./task-log-ctx.js";
import type { ScheduledTask } from "./task-types.js";
import { isSystemEntry, formatTaskLabel } from "./task-types.js";
import { getSystemTaskRegistry } from "./system-task-registry.js";
import { ScheduledTaskRunner } from "./scheduled-task-runner.js";
import { settleRunOnce } from "./task-run-settler.js";
import { makeTaskFailure } from "./task-failure.js";
import { getControl } from "../execution-control.js";
import type { ActiveTaskRun } from "./task-state-store.js";
import type { TaskFailureDiagnosticV1 } from "./task-failure.js";

const TAG = "cron-queue";
const PRIO_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
// #1520: the queue snapshot lives under abtarsHome() and is diagnostic-only —
// it never replays work and is never a second source of truth.
const STATE_FILE = join(abtarsHome(), "state", "task-queue-state.json");

interface PersistedState {
  pid: number;
  currentJob: { entryId: string; message: string; startedAt: number; type: string; runId?: string } | null;
  queue: Array<{ entryId: string; message: string; priority: string; manual: boolean; runId?: string }>;
}

function persistState(current: RunningJob | null, queue: QueuedJob[]): void {
  try {
    const state: PersistedState = {
      pid: process.pid,
      currentJob: current ? { entryId: current.entryId, message: current.message, startedAt: current.startedAt, type: current.type, runId: current.runId } : null,
      queue: queue.map(j => ({ entryId: j.entry.id, message: getEntryMessage(j.entry), priority: j.entry.priority ?? "medium", manual: j.manual ?? false, runId: j.reservation?.runId })),
    };
    writeFileSync(STATE_FILE, JSON.stringify(state), "utf-8");
  } catch (err) { logAndSwallow("cron_queue", "op", err); }
}

function loadStaleState(): PersistedState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as PersistedState;
    if (raw.pid === process.pid) return null;
    return raw;
  } catch (err) { logAndSwallow(TAG, "loadStaleState", err); return null; }
}

function getEntryMessage(entry: ScheduledTask): string {
  if (entry.kind === "reminder") return entry.text;
  if (entry.kind === "agent") return entry.prompt ?? entry.taskFile ?? "";
  if (entry.kind === "script") return entry.command;
  if (entry.kind === "system") return entry.action;
  return "";
}

export type FailInjectCallback = (entryId: string, command: string, result: string) => void;
export type TaskPausedCallback = (chatId: number, title: string, reason: string) => void;
export type AgentTaskRunner = (request: import("../spin-types.js").SpinRequest) => Promise<{ cardId: number; result: string }>;

interface QueuedJob {
  entry: ScheduledTask;
  manual?: boolean;
  reservation?: ActiveTaskRun;
}

export interface RunningJob {
  entryId: string;
  message: string;
  pid: number;
  startedAt: number;
  type: "script" | "agent" | "system";
  manual?: boolean;
  /** #1517: the exact reserved run identity; ownership never infers from task ID. */
  runId: string;
}

export class CronQueue {
  private queue: QueuedJob[] = [];
  private _current: RunningJob | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private readonly onFailInject?: FailInjectCallback;
  private readonly failCounts = new Map<string, { date: string; count: number }>();
  private readonly taskRunner: ScheduledTaskRunner;

  constructor(_cliPath: string, _workingDir: string, onFailInject?: FailInjectCallback, onTaskPaused?: TaskPausedCallback, agentRunner?: AgentTaskRunner, projectRunner?: import("./scheduled-project-runner.js").ScheduledProjectRunner) {
    this.onFailInject = onFailInject;
    this.taskRunner = new ScheduledTaskRunner({ agentRunner, onTaskPaused, projectRunner });
    // #1520: the stale snapshot is correlated against the authoritative
    // restart reconciliation (task state + history) for logging only. It
    // cannot create or replay work; both sides of the snapshot are cleared.
    const stale = loadStaleState();
    if (stale) {
      if (stale.currentJob) {
        logWarn(TAG, `Stale in-flight job observed: "${stale.currentJob.entryId}" — recovery owned by task state reconciliation`);
      }
      if (stale.queue.length > 0) {
        logWarn(TAG, `${stale.queue.length} queued job(s) observed across restart — reconciliation decides; snapshot is diagnostic only`);
      }
      persistState(null, []);
    }
  }

  get currentJob(): RunningJob | null { return this._current; }
  get pending(): number { return this.queue.length; }

  /**
   * #1517: live stale-run ownership port consumed by reconciliation. Only the
   * exact run ID currently executing is owned; cancellation is signalled
   * through the registered execution control (non-blocking) so the executor's
   * own settlement path keeps the first terminal opportunity.
   */
  owns(runId: string): boolean {
    return this._current?.runId === runId;
  }

  cancel(runId: string, _reason: string): "requested" | "not_owned" {
    if (!this.owns(runId)) return "not_owned";
    const control = getControl(runId);
    if (control) {
      const status = control.signalCancel("deadline");
      if (status === "already_terminal") return "not_owned";
    }
    return "requested";
  }

  enqueue(entry: ScheduledTask, manual?: boolean, reservation?: ActiveTaskRun): string | null {
    // #1517: a supplied reservation rejected before queue ownership transfers
    // must never remain active_run — terminalize it exactly once.
    if (this._current?.entryId === entry.id) {
      if (reservation) this.rejectReservation(entry, reservation, "duplicate-current");
      return `Already running: "${getEntryMessage(entry).slice(0, 60)}"`;
    }
    if (this.queue.some(j => j.entry.id === entry.id)) {
      if (reservation) this.rejectReservation(entry, reservation, "duplicate-queued");
      return `Already queued: "${getEntryMessage(entry).slice(0, 60)}"`;
    }

    // #1517: manual callers acquire the reservation at admission so every
    // executable queued/current job owns an exact run ID before transfer.
    // A scheduled caller's supplied reservation is authoritative and is never
    // replaced or re-allocated by executor branches.
    const owned = reservation ?? this.reserveForEntry(entry, manual);
    if (!owned) {
      return `Cannot run: "${getEntryMessage(entry).slice(0, 60)}" — active run in progress`;
    }

    const rank = PRIO_RANK[entry.priority ?? "medium"] ?? 1;
    let i = 0;
    try {
      while (i < this.queue.length) {
        const qRank = PRIO_RANK[this.queue[i]!.entry.priority ?? "medium"] ?? 1;
        if (rank < qRank) break;
        i++;
      }
      this.queue.splice(i, 0, { entry, manual, reservation: owned });
    } catch (err) {
      logAndSwallow(TAG, "enqueue insert", err);
      this.rejectReservation(entry, owned, "queue-insertion-failed");
      return "Queue error: task could not be admitted";
    }
    logInfo(TAG, `Enqueued "${entry.id}" (${entry.kind}, ${entry.priority ?? "medium"}${manual ? ", manual" : ""}) — ${this.queue.length} pending`);
    logTaskDebug("task_queue_state", { task: entry.id, run: owned.runId }, `pending=${this.queue.length} manual=${manual === true}`);
    persistState(this._current, this.queue);

    if (!this._current) this.processNext();
    return null;
  }

  /**
   * #1517: a reservation that never gained queue ownership is terminalized
   * with a bounded queue-admission detail under its own run ID. The
   * interruption/cancelled policy clears without retry or failure counting,
   * so the occurrence ends cleanly and future runs are not blocked.
   */
  private rejectReservation(entry: ScheduledTask, run: ActiveTaskRun, detail: string): void {
    settleRunOnce({
      entry, run, outcome: "cancelled",
      diagnostic: makeTaskFailure("interruption", "cancelled", "queued",
        `queue admission rejected: ${detail}`, "none"),
      detail: `queue_admission_rejected: ${detail}`,
    });
    logWarn(TAG, `Reservation for "${entry.id}" run=${run.runId} rejected at queue admission (${detail}) — settled as cancelled`);
  }

  private processNext(): void {
    if (this.queue.length === 0) return;
    const job = this.queue.shift()!;
    const { entry, manual, reservation } = job;

    // #1517: a queued job may outlive its reservation (live reconciliation
    // settles expired unowned runs). Never execute side effects for a run
    // that no longer owns the active reservation.
    if (reservation) {
      const state = readState(entry.id);
      if (!state?.activeRun || state.activeRun.runId !== reservation.runId) {
        logWarn(TAG, `Job "${entry.id}" run=${reservation.runId} no longer owns the active reservation — skipping execution`);
        this.processNext();
        return;
      }
    }
    if (isSystemEntry(entry)) {
      this.runSystem(entry, manual, reservation);
    } else if (entry.kind === "script") {
      this.runScript(entry, manual, reservation);
    } else if (entry.kind === "agent") {
      this.runAgent(entry, manual, reservation);
    } else if (entry.kind === "reminder") {
      // Reminders are settled immediately by checkCron(); a stray queued copy
      // must not strand its reservation.
      if (reservation) {
        settleRunOnce({ entry, run: reservation, outcome: "success", detail: "reminder already delivered" });
      }
      logInfo(TAG, `Reminder "${entry.id}" already delivered — skipping`);
      this.processNext();
    }
  }

  private setCurrent(entry: ScheduledTask, pid: number, type: "script" | "agent" | "system", manual: boolean | undefined, runId: string): void {
    this._current = {
      entryId: entry.id,
      message: getEntryMessage(entry).slice(0, 80),
      pid,
      startedAt: Date.now(),
      type,
      manual,
      runId,
    };
    persistState(this._current, this.queue);
  }

  private clearCurrent(): void {
    if (this.timeout) { clearTimeout(this.timeout); this.timeout = null; }
    this._current = null;
    persistState(this._current, this.queue);
  }

  private tryInjectFailure(entry: ScheduledTask, result: string): void {
    if (!this.onFailInject) return;
    const today = new Date().toISOString().slice(0, 10);
    const key = entry.id;
    const fc = this.failCounts.get(key);
    if (fc && fc.date === today && fc.count >= 2) {
      logInfo(TAG, `Skip auto-fix for "${key}" — already 2 attempts today`);
      return;
    }
    const count = (fc?.date === today ? fc.count : 0) + 1;
    this.failCounts.set(key, { date: today, count });
    logInfo(TAG, `Injecting failure to agent for "${key}" (attempt ${count}/2)`);
    this.onFailInject(entry.id, getEntryMessage(entry), result);
  }

  private reserveForEntry(entry: ScheduledTask, manual?: boolean, existing?: ActiveTaskRun): ActiveTaskRun | null {
    if (existing) return existing;
    const now = Date.now();
    const res = reserveRun(entry.id, {
      runId: createRunId(entry.id),
      groupId: `${entry.id}:group:${now}`,
      attempt: manual ? 1 : (readState(entry.id)?.retrying ? 2 : 1),
      trigger: manual ? "manual" : "schedule",
      occurrenceAt: now,
      deadlineAt: now + 30 * 60 * 1000,
    });
    if (res.ok) return res.run;
    logWarn(TAG, `Cannot run "${entry.id}": active run in progress ${res.active.runId}`);
    return null;
  }

  private runSystem(entry: ScheduledTask & { kind: "system" }, manual?: boolean, reservation?: ActiveTaskRun): Promise<void> {
    if (!reservation) {
      logWarn(TAG, `System task "${entry.id}" reached execution without a reservation — skipping`);
      this.processNext();
      return Promise.resolve();
    }
    const run = reservation;
    logInfo(TAG, `System: "${entry.action}" (${entry.id})`);
    this.setCurrent(entry, 0, "system", manual, run.runId);
    return (async () => {
      try {
        const result = await getSystemTaskRegistry().dispatch(entry);
        if (result.status === "deferred") {
          settleRunOnce({
            entry, run, outcome: "deferred",
            diagnostic: makeTaskFailure("admission", "executor_unavailable", "queued", result.detail, "transient"),
            detail: result.detail,
            retryAt: result.retryAt,
          });
          logInfo(TAG, `Deferred: "${entry.action}" (${entry.id}) — retry at ${new Date(result.retryAt).toISOString()}: ${result.detail}`);
        } else if (result.status === "noop") {
          settleRunOnce({ entry, run, outcome: "noop", detail: result.detail });
          logInfo(TAG, `System noop: "${entry.action}" (${entry.id})${result.detail ? ` — ${result.detail}` : ""}`);
        } else if (result.status === "accepted") {
          settleRunOnce({ entry, run, outcome: "success", detail: result.detail });
          logInfo(TAG, `System ok: "${entry.action}" (${entry.id})${result.detail ? ` — ${result.detail}` : ""}`);
        } else {
          settleRunOnce({
            entry, run, outcome: "failed",
            diagnostic: makeTaskFailure("execution", "process_exit", "executing", result.error, "none"),
            detail: result.error,
          });
          logInfo(TAG, `System fail: "${entry.action}" (${entry.id}) — ${result.error}`);
          this.tryInjectFailure(entry, result.error);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn(TAG, `System dispatch error for "${entry.action}": ${msg}`);
        settleRunOnce({
          entry, run, outcome: "failed",
          diagnostic: makeTaskFailure("execution", "process_exit", "executing", msg, "none"),
          detail: msg,
        });
        this.tryInjectFailure(entry, msg);
      } finally {
        this.clearCurrent();
        this.processNext();
      }
    })();
  }

  private runScript(entry: ScheduledTask & { kind: "script" }, manual?: boolean, reservation?: ActiveTaskRun): void {
    if (!reservation) {
      logWarn(TAG, `Script task "${entry.id}" reached execution without a reservation — skipping`);
      this.processNext();
      return;
    }
    const run = reservation;
    logTaskDebug("task_execution_started", { task: entry.id }, "kind=script");
    try {
      const child = spawn("bash", ["-c", entry.command], { stdio: ["ignore", "pipe", "pipe"] });
      this.setCurrent(entry, child.pid ?? 0, "script", manual, run.runId);

      let output = "";
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      // #1517: absolute deadline on the reserved run. On expiry the owned
      // child is terminated through the safe process handle — never by an
      // unverified or recycled PID — with a bounded SIGKILL fallback for a
      // child that ignores SIGTERM. The run settles timed_out exactly once;
      // a late exit cannot replace that outcome.
      const deadlineTimer = setTimeout(() => {
        settled = true;
        logWarn(TAG, `Script deadline fired for task=${entry.id} run=${run.runId}`);
        try {
          if (child.exitCode === null) child.kill("SIGTERM");
        } catch { /* best effort */ }
        killTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* best effort */ }
        }, 5000);
        settleRunOnce({
          entry, run, outcome: "timed_out",
          diagnostic: makeTaskFailure("interruption", "timed_out", "executing",
            "script exceeded its deadline", "none"),
          detail: "deadline: script timed out",
        });
        this.clearCurrent();
        this.processNext();
      }, Math.max(1, run.deadlineAt - Date.now()));

      child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

      child.on("exit", (code) => {
        clearTimeout(deadlineTimer);
        if (killTimer) clearTimeout(killTimer);
        if (settled) return;
        const finishedAt = Date.now();
        const ok = code === 0;
        const diagnostic: TaskFailureDiagnosticV1 = ok
          ? makeTaskFailure("execution", "process_exit", "executing", "script exited 0", "none")
          : makeTaskFailure("execution", "process_exit", "executing", `script exited ${code}`, "none");
        settleRunOnce({ entry, run, outcome: ok ? "success" : "failed", diagnostic, detail: (output || `exit ${code}`).slice(0, 500) });
        const followUp = entry.followUp;
        if (ok && output.trim() && followUp) {
          logInfo(TAG, `Gate triggered → enqueuing agent follow-up for "${entry.id}"`);
          this.clearCurrent();
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
          this.enqueue(agentEntry);
          return;
        }
        if (!ok) {
          addTaskFailure({ taskName: formatTaskLabel(entry.id), exitCode: code ?? 1, error: (output || "").slice(0, 100), timestamp: finishedAt, consecutiveFailures: 1 });
          this.tryInjectFailure(entry, `${code === 0 ? "ok" : `exit ${code}`}\n${(output || "(no output)").slice(0, 500)}`);
        }
        this.clearCurrent();
        this.processNext();
      });

      child.on("error", (err) => {
        clearTimeout(deadlineTimer);
        if (killTimer) clearTimeout(killTimer);
        if (settled) return;
        logWarn(TAG, `Script spawn failed for task=${entry.id} (error_chars=${err.message.length})`);
        settleRunOnce({
          entry, run, outcome: "failed",
          diagnostic: makeTaskFailure("dependency", "executable_missing", "preflight", `spawn failed: ${err.message.slice(0, 200)}`, "permanent"),
          detail: err.message.slice(0, 500),
        });
        this.clearCurrent();
        this.processNext();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `Script error for task=${entry.id} (error_chars=${message.length})`);
      settleRunOnce({
        entry, run, outcome: "failed",
        diagnostic: makeTaskFailure("dependency", "executable_missing", "preflight", message.slice(0, 200), "permanent"),
        detail: message.slice(0, 500),
      });
      this.clearCurrent();
      this.processNext();
    }
  }

  private async runAgent(entry: ScheduledTask & { kind: "agent" }, manual?: boolean, reservation?: ActiveTaskRun): Promise<void> {
    if (!reservation) {
      logWarn(TAG, `Agent task "${entry.id}" reached execution without a reservation — skipping`);
      this.clearCurrent();
      this.processNext();
      return;
    }
    const run = reservation;
    this.setCurrent(entry, 0, "agent", manual, run.runId);

    try {
      const outcome = await this.taskRunner.run(entry, run);
      logTaskDebug("task_settled", { task: entry.id, run: run.runId }, `outcome=${outcome.status}`);
    } catch (err) {
      logWarn(TAG, `runAgent error for "${entry.id}": ${err instanceof Error ? err.message : String(err)}`);
      const msg = err instanceof Error ? err.message : String(err);
      settleRunOnce({
        entry, run, outcome: "failed",
        diagnostic: makeTaskFailure("execution", "model_error", "executing", msg.slice(0, 500), "none"),
        detail: msg.slice(0, 500),
      });
    } finally {
      this.clearCurrent();
      this.processNext();
    }
  }
}
