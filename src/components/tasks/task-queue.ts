import { logAndSwallow } from "../log-and-swallow.js";
import { addTaskFailure } from "./task-failure-buffer.js";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logInfo, logWarn } from "../logger.js";
import { incrementFailures, resetFailures, setAutoPaused, updateState, readState, reserveRun } from "./task-state-store.js";
import { appendRun } from "./task-history-store.js";
import { logTaskDebug } from "./task-log-ctx.js";
import type { ScheduledTask } from "./task-types.js";
import { isSystemEntry, formatTaskLabel } from "./task-types.js";
import { getSystemTaskRegistry } from "./system-task-registry.js";
import { ScheduledTaskRunner } from "./scheduled-task-runner.js";
import type { ActiveTaskRun } from "./task-state-store.js";

const TAG = "cron-queue";
const PRIO_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const STATE_FILE = join(homedir(), ".abtars", "state", "task-queue-state.json");

interface PersistedState {
  pid: number;
  currentJob: { entryId: string; message: string; startedAt: number; type: string } | null;
  queue: Array<{ entryId: string; message: string; priority: string; manual: boolean }>;
}

function persistState(current: RunningJob | null, queue: QueuedJob[]): void {
  try {
    const state: PersistedState = {
      pid: process.pid,
      currentJob: current ? { entryId: current.entryId, message: current.message, startedAt: current.startedAt, type: current.type } : null,
      queue: queue.map(j => ({ entryId: j.entry.id, message: getEntryMessage(j.entry), priority: j.entry.priority ?? "medium", manual: j.manual ?? false })),
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
  if (entry.kind === "orc") return entry.goal;
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
}

export class CronQueue {
  private queue: QueuedJob[] = [];
  private _current: RunningJob | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private readonly onFailInject?: FailInjectCallback;
  private readonly onTaskPaused?: TaskPausedCallback;
  private readonly failCounts = new Map<string, { date: string; count: number }>();
  private readonly taskRunner: ScheduledTaskRunner;

  constructor(_cliPath: string, _workingDir: string, onFailInject?: FailInjectCallback, onTaskPaused?: TaskPausedCallback, agentRunner?: AgentTaskRunner) {
    this.onFailInject = onFailInject;
    this.onTaskPaused = onTaskPaused;
    this.taskRunner = new ScheduledTaskRunner({ agentRunner, onTaskPaused, onFailInject });
    const stale = loadStaleState();
    if (stale) {
      if (stale.currentJob) {
        logWarn(TAG, `Stale in-flight job detected: "${stale.currentJob.entryId}" (PID ${stale.pid} dead) — marking failed`);
      }
      if (stale.queue.length > 0) {
        logWarn(TAG, `${stale.queue.length} stale queued job(s) from previous process — dropped`);
      }
      persistState(null, []);
    }
  }

  get currentJob(): RunningJob | null { return this._current; }
  get pending(): number { return this.queue.length; }

  enqueue(entry: ScheduledTask, manual?: boolean, reservation?: ActiveTaskRun): string | null {
    if (this._current?.entryId === entry.id) {
      return `Already running: "${getEntryMessage(entry).slice(0, 60)}"`;
    }
    if (this.queue.some(j => j.entry.id === entry.id)) {
      return `Already queued: "${getEntryMessage(entry).slice(0, 60)}"`;
    }

    const rank = PRIO_RANK[entry.priority ?? "medium"] ?? 1;
    let i = 0;
    while (i < this.queue.length) {
      const qRank = PRIO_RANK[this.queue[i]!.entry.priority ?? "medium"] ?? 1;
      if (rank < qRank) break;
      i++;
    }
    this.queue.splice(i, 0, { entry, manual, reservation });
    logInfo(TAG, `Enqueued "${entry.id}" (${entry.kind}, ${entry.priority ?? "medium"}${manual ? ", manual" : ""}) — ${this.queue.length} pending`);
    logTaskDebug("task_queue_state", { task: entry.id }, `pending=${this.queue.length} manual=${manual === true}`);
    persistState(this._current, this.queue);

    if (!this._current) this.processNext();
    return null;
  }

  private processNext(): void {
    if (this.queue.length === 0) return;
    const job = this.queue.shift()!;
    const { entry, manual, reservation } = job;

    if (isSystemEntry(entry)) {
      this.runSystem(entry, manual);
    } else if (entry.kind === "script") {
      this.runScript(entry, manual);
    } else if (entry.kind === "orc") {
      this.runOrc(entry, manual);
    } else if (entry.kind === "agent") {
      this.runAgent(entry, manual, reservation);
    } else if (entry.kind === "reminder") {
      logInfo(TAG, `Reminder "${entry.id}" already delivered — skipping`);
      this.processNext();
    }
  }

  private setCurrent(entry: ScheduledTask, pid: number, type: "script" | "agent" | "system", manual?: boolean): void {
    this._current = {
      entryId: entry.id,
      message: getEntryMessage(entry).slice(0, 80),
      pid,
      startedAt: Date.now(),
      type,
      manual,
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

  private checkAutoPause(entry: ScheduledTask, exitCode: number, lastError: string): boolean {
    if (!entry.schedule) return false;
    if (exitCode === 0) {
      resetFailures(entry.id);
      return false;
    }
    const count = incrementFailures(entry.id);
    if (count >= 3) {
      setAutoPaused(entry.id, true);
      logWarn(TAG, `Auto-paused "${entry.id}" after ${count} consecutive failures`);
      this.onTaskPaused?.(parseInt(entry.chatId ?? "0", 10), formatTaskLabel(entry.id), `failed ${count}x: ${lastError.slice(0, 150)}`);
      return true;
    }
    return false;
  }

  private trigger(entryId: string, manual?: boolean): "schedule" | "manual" | "retry" {
    if (manual) return "manual";
    const state = readState(entryId);
    if (state?.retrying) return "retry";
    return "schedule";
  }

  private async runSystem(entry: ScheduledTask & { kind: "system" }, manual?: boolean): Promise<void> {
    logInfo(TAG, `System: "${entry.action}" (${entry.id})`);
    this.setCurrent(entry, 0, "system", manual);
    try {
      const result = await getSystemTaskRegistry().dispatch(entry);
      const finishedAt = Date.now();
      if (result.status === "deferred") {
        appendRun({ taskId: entry.id, kind: entry.kind, trigger: this.trigger(entry.id, manual), startedAt: this._current?.startedAt ?? finishedAt, finishedAt, outcome: "deferred", detail: result.detail, groupId: `${entry.id}:sys:${finishedAt}` });
        logInfo(TAG, `Deferred: "${entry.action}" (${entry.id}) — retry at ${new Date(result.retryAt).toISOString()}: ${result.detail}`);
        updateState(entry.id, { nextRunAt: result.retryAt, retryAt: result.retryAt, retrying: true });
      } else if (result.status === "noop") {
        appendRun({ taskId: entry.id, kind: entry.kind, trigger: this.trigger(entry.id, manual), startedAt: this._current?.startedAt ?? finishedAt, finishedAt, outcome: "noop", detail: result.detail, groupId: `${entry.id}:sys:${finishedAt}` });
        logInfo(TAG, `System noop: "${entry.action}" (${entry.id})${result.detail ? ` — ${result.detail}` : ""}`);
      } else {
        const ok = result.status === "accepted";
        const detail = ok ? (result as { status: "accepted"; detail?: string }).detail : (result as { status: "failed"; error: string }).error;
        appendRun({ taskId: entry.id, kind: entry.kind, trigger: this.trigger(entry.id, manual), startedAt: this._current?.startedAt ?? finishedAt, finishedAt, outcome: ok ? "success" : "failed", detail, groupId: `${entry.id}:sys:${finishedAt}` });
        logInfo(TAG, `System ${ok ? "ok" : "fail"}: "${entry.action}" (${entry.id})${detail ? ` — ${detail}` : ""}`);
        if (!ok) this.checkAutoPause(entry, 1, detail ?? "");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `System dispatch error for "${entry.action}": ${msg}`);
      appendRun({ taskId: entry.id, kind: entry.kind, trigger: this.trigger(entry.id, manual), startedAt: this._current?.startedAt ?? Date.now(), finishedAt: Date.now(), outcome: "failed", detail: msg, groupId: `${entry.id}:sys:${Date.now()}` });
      this.checkAutoPause(entry, 1, msg);
    } finally {
      this.clearCurrent();
      this.processNext();
    }
  }

  private runOrc(entry: ScheduledTask & { kind: "orc" }, _manual?: boolean): void {
    logTaskDebug("task_execution_started", { task: entry.id }, "kind=orc");
    import("../spin.js").then(({ spin }) => {
      spin.dispatch({ type: "O", goal: entry.goal, source: "task", priority: entry.priority ?? "MEDIUM", settlementOwner: "spin" });
      this.clearCurrent();
      this.processNext();
    }).catch((err) => {
      logWarn(TAG, `Orc dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      this.clearCurrent();
      this.processNext();
    });
  }

  private runScript(entry: ScheduledTask & { kind: "script" }, manual?: boolean): void {
    logTaskDebug("task_execution_started", { task: entry.id }, "kind=script");
    try {
      const child = spawn("bash", ["-c", entry.command], { stdio: ["ignore", "pipe", "pipe"] });
      this.setCurrent(entry, child.pid ?? 0, "script", manual);

      let output = "";
      child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

      child.on("exit", (code) => {
        const finishedAt = Date.now();
        appendRun({ taskId: entry.id, kind: entry.kind, trigger: this.trigger(entry.id, manual) === "retry" ? "retry" : manual ? "manual" : "schedule", startedAt: this._current?.startedAt ?? finishedAt, finishedAt, outcome: code === 0 ? "success" : "failed", detail: output.slice(0, 200), groupId: `${entry.id}:script:${finishedAt}` });
        const paused = this.checkAutoPause(entry, code ?? 1, (output || "(no output)").slice(0, 200));
        const followUp = entry.followUp;
        if (code === 0 && output.trim() && followUp) {
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
          };
          this.enqueue(agentEntry);
          return;
        }
        if (code !== 0) {
          if (!paused) this.tryInjectFailure(entry, `${code === 0 ? "ok" : `exit ${code}`}\n${(output || "(no output)").slice(0, 500)}`);
          addTaskFailure({ taskName: formatTaskLabel(entry.id), exitCode: code ?? 1, error: (output || "").slice(0, 100), timestamp: finishedAt, consecutiveFailures: 1 });
        }
        this.clearCurrent();
        this.processNext();
      });

      child.on("error", (err) => {
        logWarn(TAG, `Script spawn failed for task=${entry.id} (error_chars=${err.message.length})`);
        this.clearCurrent();
        this.processNext();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `Script error for task=${entry.id} (error_chars=${message.length})`);
      this.clearCurrent();
      this.processNext();
    }
  }

  private async runAgent(entry: ScheduledTask & { kind: "agent" }, manual?: boolean, reservation?: ActiveTaskRun): Promise<void> {
    this.setCurrent(entry, 0, "agent", manual);

    try {
      let runReservation = reservation;
      if (!runReservation) {
        const now = Date.now();
        const res = reserveRun(entry.id, {
          runId: `${entry.id}_${now}`,
          groupId: `${entry.id}:group:${now}`,
          attempt: manual ? 1 : (readState(entry.id)?.retrying ? 2 : 1),
          trigger: manual ? "manual" : "schedule",
          occurrenceAt: now,
          deadlineAt: now + 30 * 60 * 1000,
        });
        if (res.ok) {
          runReservation = res.run;
        } else {
          logWarn(TAG, `Cannot run "${entry.id}": active run in progress ${res.active.runId}`);
          this.clearCurrent();
          this.processNext();
          return;
        }
      }

      const outcome = await this.taskRunner.run(entry, runReservation);
      logTaskDebug("task_settled", { task: entry.id, run: runReservation.runId }, `outcome=${outcome.status}`);
      if (outcome.status === "failed" || outcome.status === "timed_out" || outcome.status === "cancelled") {
        this.checkAutoPause(entry, 1, outcome.safeDetail ?? "failed");
      }
    } catch (err) {
      logWarn(TAG, `runAgent error for "${entry.id}": ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.clearCurrent();
      this.processNext();
    }
  }
}
