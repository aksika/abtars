import { logAndSwallow } from "../log-and-swallow.js";
import { addTaskFailure } from "./task-failure-buffer.js";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, accessSync, writeFileSync, mkdirSync, readFileSync, renameSync, constants as fsConstants } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { abtarsHome } from "../../paths.js";
import { logInfo, logWarn, logDebug, logTrace } from "../logger.js";
import { readLastPromptAt } from "../transport/bridge-lock-transport.js";
import { incrementFailures, incrementDeferrals, resetFailures, setAutoPaused, advanceNextRun, updateState, readState } from "./task-state-store.js";
import { appendRun } from "./task-history-store.js";
import { kanbanComplete, kanbanFail } from "./kanban-board.js";
import { createExecutionScope } from "./task-package.js";
import { logTaskDebug, logTaskTrace } from "./task-log-ctx.js";
import type { ScheduledTask } from "./task-types.js";
import { isSystemEntry, formatTaskLabel } from "./task-types.js";
import { getSystemTaskRegistry } from "./system-task-registry.js";
import { localDate } from "../../utils/date.js";

type ValidatedOutput =
  | { ok: true; content: string }
  | { ok: false; reason: string };

const REPORT_MIN_BYTES = 100;

function validateAgentOutput(raw: unknown, minBytes?: number): ValidatedOutput {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "task produced no output" };
  }
  let content: string;
  if (typeof raw === "string") {
    content = raw;
  } else {
    return { ok: false, reason: "task produced no output (non-string response)" };
  }
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && "exit_code" in parsed) {
      if (typeof parsed.exit_code !== "number" || !Number.isInteger(parsed.exit_code)) {
        return { ok: false, reason: "task produced an invalid structured exit code" };
      }
      if (parsed.exit_code !== 0) {
        return { ok: false, reason: `task command failed (exit code ${parsed.exit_code})` };
      }
      const stdout = typeof parsed.stdout === "string" ? parsed.stdout : "";
      const stderr = typeof parsed.stderr === "string" ? parsed.stderr : "";
      if (!stdout && !stderr) {
        return { ok: false, reason: "task produced no output (empty stdout and stderr)" };
      }
      content = stdout || stderr;
    }
  } catch {
    // not structured JSON output, use as-is
  }
  if (!content.trim()) {
    return { ok: false, reason: "task produced no output (empty/whitespace-only)" };
  }
  const trimmed = content.trim();
  if (trimmed === "(no output)" || trimmed === "(task completed)") {
    return { ok: false, reason: `task produced no output (sentinel: "${trimmed}")` };
  }
  if (minBytes && Buffer.byteLength(content, "utf-8") < minBytes) {
    return { ok: false, reason: `output too short (${Buffer.byteLength(content, "utf-8")} bytes, minimum ${minBytes})` };
  }
  return { ok: true, content };
}



const TAG = "cron-queue";
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const RETRY_DELAY_MS = 10 * 60 * 1000;
const MAX_IDLE_DEFERRALS = 5;

/** #1502: Terminal latch — prevents stale late results from overwriting settled outcomes. */
const _settledRunIds = new Set<string>();
function isRunSettled(runId: string): boolean { return _settledRunIds.has(runId); }
function markRunSettled(runId: string): void { _settledRunIds.add(runId); }
function clearRunSettled(runId: string): void { _settledRunIds.delete(runId); }
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

let _settleSeq = 0;

interface TaskRunGroup {
  groupId: string;
  taskId: string;
  trigger: "schedule" | "manual";
  attempt: 1 | 2;
  priorFailure?: string;
}

/**
 * Single settlement point for a run. Appends history and updates the scheduling
 * cursor. Protected by terminal latch: once a runId is settled, subsequent calls
 * for the same runId are ignored.
 */
function settleRun(entry: ScheduledTask, outcome: "success" | "failed" | "noop" | "deferred" | "skipped", startedAt: number, detail?: string, resultPath?: string, kanbanCardId?: number, trigger: "schedule" | "manual" | "retry" = "schedule", runId?: string): void {
  if (runId && isRunSettled(runId)) {
    logDebug("cron-queue", `Stale settlement ignored for "${entry.id}" run=${runId}`);
    return;
  }
  if (runId) markRunSettled(runId);

  const finishedAt = Date.now();
  appendRun({ taskId: entry.id, kind: entry.kind, trigger, startedAt, finishedAt, outcome, detail, resultPath, kanbanCardId, runId });

  if (outcome === "success" || outcome === "noop" || outcome === "skipped") {
    advanceNextRun(entry.id, entry.schedule);
    updateState(entry.id, { lastFinishedAt: finishedAt, retrying: false });
  } else if (outcome === "deferred") {
    updateState(entry.id, { lastFinishedAt: finishedAt });
  } else if (entry.schedule) {
    const retryAt = finishedAt + RETRY_DELAY_MS;
    updateState(entry.id, { lastFinishedAt: finishedAt, nextRunAt: retryAt, retryAt, retrying: true });
    logInfo(TAG, `Retry scheduled for "${entry.id}" in ${RETRY_DELAY_MS / 60000}min`);
  } else {
    updateState(entry.id, { lastFinishedAt: finishedAt, completed: true });
  }
}

function writeResultFile(entryId: string, content: string): string | null {
  try {
    const dir = join(abtarsHome(), "workspace", entryId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${entryId}-${localDate()}.md`);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, content, "utf-8");
    renameSync(temp, file);
    const stat = lstatSync(file);
    accessSync(file, fsConstants.R_OK);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    logTaskTrace("report_artifact_materialized", { task: entryId }, `bytes=${stat.size}`);
    return file;
  } catch (err) { logAndSwallow(TAG, "writeResultFile", err); return null; }
}

const DOD_MIN_BYTES = 100;

export { loadTaskPackage, createExecutionScope } from "./task-package.js";
export type { TaskPackageResult, ToolExecutionScope } from "./task-package.js";

async function checkDoD(paths: string[]): Promise<{ passed: boolean; details: string }> {
  if (paths.length === 0) return { passed: true, details: "no DoD defined" };
  const results: string[] = [];
  let allPassed = true;
  for (const [pathIndex, p] of paths.entries()) {
    const label = `artifact[${pathIndex}]${basename(p) ? `:${basename(p)}` : ""}`;
    let size: number | null = null;
    let isRegular = true;
    if (existsSync(p)) {
      try {
        const st = lstatSync(p);
        size = st.size;
        isRegular = st.isFile() && !st.isSymbolicLink();
        if (isRegular) accessSync(p, fsConstants.R_OK);
      } catch {
        size = null;
      }
    } else {
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(remaining, 200)));
        if (existsSync(p)) {
          try {
            const st = lstatSync(p);
            size = st.size;
            isRegular = st.isFile() && !st.isSymbolicLink();
            if (isRegular) accessSync(p, fsConstants.R_OK);
          } catch {
            size = null;
          }
          break;
        }
      }
    }
    logTaskTrace("report_artifact_check", {}, `path_index=${paths.indexOf(p)} exists=${size !== null} regular=${isRegular} bytes=${size ?? 0}`);
    if (size === null) {
      results.push(`missing: ${label}`);
      allPassed = false;
    } else if (!isRegular) {
      // #1502: spec requires a regular readable file — reject directories,
      // devices, and symlinks that happen to live at the declared path.
      results.push(`not a regular file: ${label}`);
      allPassed = false;
    } else if (size < DOD_MIN_BYTES) {
      results.push(`too small (${size}B): ${label} (${size}B)`);
      allPassed = false;
    } else {
      results.push(`${label} (${size}B)`);
    }
  }
  return { passed: allPassed, details: results.join("\n") };
}

export type FailInjectCallback = (entryId: string, command: string, result: string) => void;
export type TaskPausedCallback = (chatId: number, title: string, reason: string) => void;
export type AgentTaskRunner = (request: import("../spin-types.js").SpinRequest) => Promise<{ cardId: number; result: string }>;

interface QueuedJob {
  entry: ScheduledTask;
  manual?: boolean;
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
  private readonly agentRunner?: AgentTaskRunner;
  private readonly failCounts = new Map<string, { date: string; count: number }>();

  constructor(_cliPath: string, _workingDir: string, onFailInject?: FailInjectCallback, onTaskPaused?: TaskPausedCallback, agentRunner?: AgentTaskRunner) {
    this.onFailInject = onFailInject;
    this.onTaskPaused = onTaskPaused;
    this.agentRunner = agentRunner;
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

  enqueue(entry: ScheduledTask, manual?: boolean): string | null {
    if (this._current?.entryId === entry.id) {
      return `⏳ Already running: "${getEntryMessage(entry).slice(0, 60)}"`;
    }
    if (this.queue.some(j => j.entry.id === entry.id)) {
      return `⏳ Already queued: "${getEntryMessage(entry).slice(0, 60)}"`;
    }

    const rank = PRIO_RANK[entry.priority ?? "medium"] ?? 1;
    let i = 0;
    while (i < this.queue.length) {
      const qRank = PRIO_RANK[this.queue[i]!.entry.priority ?? "medium"] ?? 1;
      if (rank < qRank) break;
      i++;
    }
    this.queue.splice(i, 0, { entry, manual });
    logInfo(TAG, `Enqueued "${entry.id}" (${entry.kind}, ${entry.priority ?? "medium"}${manual ? ", manual" : ""}) — ${this.queue.length} pending`);
    logTaskTrace("task_queue_state", { task: entry.id }, `pending=${this.queue.length} manual=${manual === true}`);
    persistState(this._current, this.queue);

    if (!this._current) this.processNext();
    return null;
  }

  private processNext(): void {
    if (this.queue.length === 0) return;
    const job = this.queue.shift()!;
    const { entry, manual } = job;

    if (isSystemEntry(entry)) {
      this.runSystem(entry, manual);
    } else if (entry.kind === "script") {
      this.runScript(entry, manual);
    } else if (entry.kind === "orc") {
      this.runOrc(entry, manual);
    } else if (entry.kind === "agent") {
      this.runAgent(entry, manual);
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
    const today = localDate();
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

  private trigger(): "schedule" | "manual" | "retry" {
    if (this._current?.manual) return "manual";
    const state = readState(this._current?.entryId ?? "");
    if (state?.retrying) return "retry";
    return "schedule";
  }

  private async runSystem(entry: ScheduledTask & { kind: "system" }, manual?: boolean): Promise<void> {
    logInfo(TAG, `▶ System: "${entry.action}" (${entry.id})`);
    this.setCurrent(entry, 0, "system", manual);
    try {
      const result = await getSystemTaskRegistry().dispatch(entry);
      if (result.status === "deferred") {
        settleRun(entry, "deferred", this._current?.startedAt ?? Date.now(), result.detail, undefined, undefined, this.trigger());
        logInfo(TAG, `⏸ Deferred: "${entry.action}" (${entry.id}) — retry at ${new Date(result.retryAt).toISOString()}: ${result.detail}`);
        updateState(entry.id, { nextRunAt: result.retryAt, retryAt: result.retryAt, retrying: true });
      } else if (result.status === "noop") {
        settleRun(entry, "noop", this._current?.startedAt ?? Date.now(), result.detail, undefined, undefined, this.trigger());
        const detail = result.detail ? ` — ${result.detail}` : "";
        logInfo(TAG, `■ System noop: "${entry.action}" (${entry.id})${detail}`);
      } else {
        const ok = result.status === "accepted";
        const detail = ok ? (result as { status: "accepted"; detail?: string }).detail : (result as { status: "failed"; error: string }).error;
        settleRun(entry, ok ? "success" : "failed", this._current?.startedAt ?? Date.now(), detail, undefined, undefined, this.trigger());
        logInfo(TAG, `■ System ${ok ? "✓" : "❌"}: "${entry.action}" (${entry.id})${detail ? ` — ${detail}` : ""}`);
        if (!ok) {
          this.checkAutoPause(entry, 1, detail ?? "");
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `System dispatch error for "${entry.action}": ${msg}`);
      settleRun(entry, "failed", this._current?.startedAt ?? Date.now(), msg, undefined, undefined, this.trigger());
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
        const status = code === 0 ? "✓" : `❌ (exit ${code})`;
        logTaskDebug("task_settled", { task: entry.id }, `kind=script outcome=${status}`);
        settleRun(entry, code === 0 ? "success" : "failed", this._current?.startedAt ?? Date.now(), output.slice(0, 200), undefined, undefined, this.trigger());
        const paused = this.checkAutoPause(entry, code ?? 1, (output || "(no output)").slice(0, 200));
        const followUp = entry.followUp;
        if (code === 0 && output.trim() && followUp) {
          logInfo(TAG, `■ Gate triggered → enqueuing agent follow-up for "${entry.id}"`);
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
          if (!paused) this.tryInjectFailure(entry, `${status}\n${(output || "(no output)").slice(0, 500)}`);
          addTaskFailure({ taskName: formatTaskLabel(entry.id), exitCode: code ?? 1, error: (output || "").slice(0, 100), timestamp: Date.now(), consecutiveFailures: 1 });
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

  private async runAgent(entry: ScheduledTask & { kind: "agent" }, manual?: boolean): Promise<void> {
    if (!manual) {
      const idleMs = Date.now() - readLastPromptAt();
      if (idleMs < 90_000) {
        logInfo(TAG, `Deferring agent task "${entry.id}" — user active ${Math.round(idleMs / 1000)}s ago`);
        const count = incrementDeferrals(entry.id);
        if (count >= MAX_IDLE_DEFERRALS) {
          logWarn(TAG, `Idle gate exhausted for "${entry.id}" after ${count} deferrals — running despite active user`);
          logTaskDebug("task_deferred_budget_exhausted", { task: entry.id }, `deferrals=${count}`);
        } else {
          const deferredAt = Date.now();
          appendRun({ taskId: entry.id, kind: entry.kind, trigger: "schedule", startedAt: deferredAt, finishedAt: deferredAt, outcome: "deferred", detail: `idle_gate:user_active deferrals=${count}` });
          logTaskDebug("task_deferred", { task: entry.id }, `reason=idle_gate deferrals=${count}`);
          logTaskTrace("task_deferred_predicate", { task: entry.id }, `idle_ms=${idleMs} deferrals=${count}`);
          advanceNextRun(entry.id, entry.schedule);
          this.clearCurrent();
          this.processNext();
          return;
        }
      }
    }

    let prompt = entry.prompt ?? "";
    let dodPaths: string[] = [];
    let contextFileSummary = "count=0";
    if (entry.taskFile) {
      const { loadTaskPackage } = await import("./task-package.js");
      const task = loadTaskPackage(entry.taskFile);
      if (task.ok) {
        prompt = task.prompt;
        dodPaths = task.dodPaths;
        contextFileSummary = `count=${task.contextFiles.length} chars=${task.contextFiles.reduce((sum, file) => sum + file.chars, 0)}`;
      } else {
        logWarn(TAG, `Falling back to inline message for "${entry.id}": ${task.error}`);
      }
    }

    const contextFile = join(abtarsHome(), "workspace", entry.id, "CONTEXT.md");
    if (existsSync(contextFile)) {
      const raw = readFileSync(contextFile, "utf-8").trim();
      if (raw) {
        const ctx = raw.length > 30000 ? (logWarn(TAG, `Task context truncated (${raw.length} > 30000)`), raw.slice(0, 30000)) : raw;
        prompt = `[TASK CONTEXT — your notes from previous runs]\n${ctx}\n\n[TASK]\n${prompt}`;
        logInfo(TAG, `Injected task context (${ctx.length} chars)`);
      }
    }

    logTaskDebug("task_package_loaded", { task: entry.id }, `delivery=${entry.delivery}`);
    logTaskTrace("task_package_context", { task: entry.id }, contextFileSummary);

    if (entry.targetUserId) {
      this.setCurrent(entry, 0, "agent", manual);
      try {
        const { spin } = await import("../spin.js");
        const response = await spin.injectGreeting(entry.targetUserId, prompt);
        if (response) {
          settleRun(entry, "success", this._current?.startedAt ?? Date.now(), undefined, undefined, undefined, this.trigger());
          logInfo(TAG, `Greeting delivered to ${entry.targetUserId}`);
        } else {
          settleRun(entry, "failed", this._current?.startedAt ?? Date.now(), "greeting returned no response", undefined, undefined, this.trigger());
          logWarn(TAG, `Greeting failed for ${entry.targetUserId}`);
        }
      } catch (err) {
        settleRun(entry, "failed", this._current?.startedAt ?? Date.now(), err instanceof Error ? err.message : String(err), undefined, undefined, this.trigger());
        logWarn(TAG, `Greeting error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.clearCurrent();
        this.processNext();
      }
      return;
    }

    this.setCurrent(entry, 0, "agent", manual);

    const workspace = join(abtarsHome(), "workspace", entry.id);
    mkdirSync(workspace, { recursive: true });

    const { registerControl, removeControl } = await import("../execution-control.js");

    const AGENT_SESSION: Record<string, string> = { professor: "A", browsie: "B", coding: "C", dreamy: "D" };
    const sessionType = (AGENT_SESSION[entry.agent] ?? "T") as import("../spin-types.js").SessionType;

    const runId = `${entry.id}_${Date.now()}_${++_settleSeq}`;
    const execControl = registerControl(runId, { cardId: undefined });
    logTaskTrace("task_workspace_scope", { task: entry.id, exec: runId }, "scope=task-local");

    const state = readState(entry.id);
    // #1502 Task 9: a manual trigger starts its own bounded run group — it must
    // not inherit attempt-2/retry identity from a sticky retrying flag left by a
    // prior scheduled failure. Otherwise /task run <id> while a retry is pending
    // would be recorded as trigger="retry" attempt=2 and consume the group's
    // single retry instead of starting fresh.
    const persistedRetryGroup = !manual && state?.retrying && state.retryGroupId && state.retryAttempt === 1
      ? state.retryGroupId
      : undefined;
    const group: TaskRunGroup = {
      groupId: persistedRetryGroup ?? `${entry.id}:group:${runId}`,
      taskId: entry.id,
      trigger: manual ? "manual" : "schedule",
      attempt: persistedRetryGroup ? 2 : 1,
      priorFailure: persistedRetryGroup ? state?.priorFailure : undefined,
    };
    const isRetry = group.attempt === 2;
    const groupAttempt = group.attempt;
    const groupTrigger: "schedule" | "manual" | "retry" = isRetry ? "retry" : group.trigger;
    logTaskDebug("task_run_reserved", { task: entry.id, run: group.groupId, attempt: groupAttempt, exec: runId });

    if (isRetry && group.priorFailure) {
      const priorBlock = `[PREVIOUS ATTEMPT]\nThe previous attempt failed: ${group.priorFailure}\nChange strategy; do not repeat the failed action unchanged.\n[/PREVIOUS ATTEMPT]\n\n`;
      prompt = priorBlock + prompt;
      logInfo(TAG, `Retrying "${entry.id}" with prior-failure diagnostic`);
      logTrace(TAG, `task_retry_with_diagnostic run=${runId} task=${entry.id} attempt=2`);
    }

    let runner = this.agentRunner;
    if (!runner) {
      const { spin } = await import("../spin.js");
      runner = spin.dispatchAwait.bind(spin);
    }
    runner({
      timeoutMs: AGENT_TIMEOUT_MS,
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
      executionScope: createExecutionScope(entry.id),
    })
      .then(async ({ cardId: boardId, result: response }) => {
        const startedAt = this._current?.startedAt ?? Date.now();

        // #1502 §7: if cancellation won (kill/shutdown marked the control), do
        // not deliver or retry — settle exactly once as cancelled. Without this,
        // a run killed mid-flight could still deliver a result on completion.
        if (execControl.cancelled) {
          const reason = execControl.cancelReason ?? "cancelled";
          try { kanbanFail(boardId, `run ${reason}`); } catch { /* best effort */ }
          advanceNextRun(entry.id, entry.schedule);
          updateState(entry.id, { lastFinishedAt: Date.now(), retrying: false, retryGroupId: undefined, retryAttempt: undefined, priorFailure: undefined });
          appendRun({ taskId: entry.id, kind: entry.kind, trigger: groupTrigger, startedAt, finishedAt: Date.now(), outcome: "cancelled", detail: `cancelled: ${reason}`, kanbanCardId: boardId, runId, groupId: group.groupId });
          logInfo(TAG, `Run "${entry.id}" settled as cancelled (control won: ${reason})`);
          return;
        }

        const isReport = entry.delivery === "report";
        let exitCode = 0;
        let resultPath: string | null = null;
        let summary = "";
        let settlementDetail = "";
        logTaskTrace("task_validation_started", { task: entry.id, card: boardId, exec: runId }, `report=${isReport} dod=${dodPaths.length} response_bytes=${Buffer.byteLength(response ?? "", "utf8")}`);

        if (isReport && dodPaths.length > 0) {
          const dod = await checkDoD(dodPaths);
          if (dod.passed) {
            resultPath = dodPaths[0]!;
            summary = response.slice(0, 500);
            exitCode = 0;
          } else {
            settlementDetail = `DoD failed: ${dod.details}`;
            exitCode = 1;
          }
        } else if (response) {
          const validation = validateAgentOutput(response, isReport ? REPORT_MIN_BYTES : undefined);
          if (validation.ok) {
            const cleaned = validation.content;
            summary = cleaned.slice(0, 500);
            if (isReport) {
              const written = writeResultFile(entry.id, cleaned);
              if (written) {
                resultPath = written;
                exitCode = 0;
              } else {
                settlementDetail = "report artifact could not be materialized to workspace";
                exitCode = 1;
              }
            } else {
              exitCode = 0;
            }
          } else {
            settlementDetail = validation.reason;
            exitCode = 1;
          }
        } else {
          settlementDetail = "task produced no output";
          exitCode = 1;
        }

        if (exitCode === 0) {
          const kanbanSummary = isReport ? (summary || "report artifact verified") : (response ?? "");
          kanbanComplete(boardId, resultPath, kanbanSummary);
          updateState(entry.id, { lastFinishedAt: Date.now(), retrying: false, retryGroupId: undefined, retryAttempt: undefined, priorFailure: undefined });
          resetFailures(entry.id);
          advanceNextRun(entry.id, entry.schedule);
          appendRun({ taskId: entry.id, kind: entry.kind, trigger: groupTrigger, startedAt, finishedAt: Date.now(), outcome: "success", detail: settlementDetail || summary, resultPath: resultPath ?? undefined, kanbanCardId: boardId, runId, groupId: group.groupId });
          logTaskDebug("task_settled", { task: entry.id, run: group.groupId, exec: runId }, "outcome=success");
        } else {
          kanbanFail(boardId, settlementDetail || summary);
          if (groupAttempt === 1 && entry.schedule) {
            const retryAt = Date.now() + RETRY_DELAY_MS;
            updateState(entry.id, { lastFinishedAt: Date.now(), nextRunAt: retryAt, retryAt, retrying: true, retryGroupId: group.groupId, retryAttempt: 1, priorFailure: (settlementDetail || summary).slice(0, 200) });
            appendRun({ taskId: entry.id, kind: entry.kind, trigger: groupTrigger, startedAt, finishedAt: Date.now(), outcome: "failed", detail: settlementDetail || summary, resultPath: undefined, kanbanCardId: boardId, runId, groupId: group.groupId });
            logInfo(TAG, `Retry scheduled for "${entry.id}": attempt 1 failed, retry in ${RETRY_DELAY_MS / 60000}min`);
            logTaskDebug("task_retry_scheduled", { task: entry.id, run: group.groupId, attempt: 1, exec: runId });
          } else {
            advanceNextRun(entry.id, entry.schedule);
            updateState(entry.id, { retrying: false, retryGroupId: undefined, retryAttempt: undefined, priorFailure: undefined, lastFinishedAt: Date.now() });
            appendRun({ taskId: entry.id, kind: entry.kind, trigger: groupTrigger, startedAt, finishedAt: Date.now(), outcome: "failed", detail: settlementDetail || summary, resultPath: undefined, kanbanCardId: boardId, runId, groupId: group.groupId });
            logTaskDebug("task_settled", { task: entry.id, run: group.groupId, attempt: groupAttempt, exec: runId }, "outcome=failed");
            const failCount = incrementFailures(entry.id);
            if (failCount >= 3) {
              setAutoPaused(entry.id, true);
              logWarn(TAG, `Auto-paused "${entry.id}" after ${failCount} run groups failed`);
              this.onTaskPaused?.(parseInt(entry.chatId ?? "0", 10), formatTaskLabel(entry.id), `failed ${failCount} groups: ${(settlementDetail || summary).slice(0, 100)}`);
            } else {
              this.tryInjectFailure(entry, `${settlementDetail || summary}`);
            }
          }
        }
      })
      .catch((err: unknown) => {
        const startedAt = this._current?.startedAt ?? Date.now();
        const msg = err instanceof Error ? err.message : String(err);
        // #1502: spin() attaches the cardId to the rejected error so a caller-owned
        // settler can fail the Kanban card — otherwise a rejected dispatchAwait
        // (execution throw / pre-exec failure) orphans the card in "running".
        const boardId = (err as { cardId?: number }).cardId;
        logWarn(TAG, `Agent failed for task=${entry.id} (error_chars=${msg.length})`);
        if (boardId !== undefined) {
          try { kanbanFail(boardId, msg.slice(0, 500)); } catch { /* best effort */ }
        }
        if (groupAttempt === 1 && entry.schedule) {
          const retryAt = Date.now() + RETRY_DELAY_MS;
          updateState(entry.id, { lastFinishedAt: Date.now(), nextRunAt: retryAt, retryAt, retrying: true, retryGroupId: group.groupId, retryAttempt: 1, priorFailure: msg.slice(0, 200) });
          appendRun({ taskId: entry.id, kind: entry.kind, trigger: groupTrigger, startedAt, finishedAt: Date.now(), outcome: "failed", detail: msg, kanbanCardId: boardId, runId, groupId: group.groupId });
          logTaskDebug("task_retry_scheduled", { task: entry.id, run: group.groupId, attempt: 1, exec: runId });
        } else {
          advanceNextRun(entry.id, entry.schedule);
          updateState(entry.id, { retrying: false, retryGroupId: undefined, retryAttempt: undefined, priorFailure: undefined, lastFinishedAt: Date.now() });
          appendRun({ taskId: entry.id, kind: entry.kind, trigger: groupTrigger, startedAt, finishedAt: Date.now(), outcome: "failed", detail: msg, kanbanCardId: boardId, runId, groupId: group.groupId });
          const failCount = incrementFailures(entry.id);
          if (failCount >= 3) {
            setAutoPaused(entry.id, true);
            logWarn(TAG, `Auto-paused "${entry.id}" after ${failCount} run groups failed`);
            this.onTaskPaused?.(parseInt(entry.chatId ?? "0", 10), formatTaskLabel(entry.id), `failed ${failCount} groups: ${msg.slice(0, 100)}`);
          } else {
            this.tryInjectFailure(entry, msg);
          }
        }
      })
      .finally(() => {
        removeControl(runId);
        clearRunSettled(runId);
        logTaskTrace("task_resources_released", { task: entry.id, exec: runId }, "control=removed queue=advanced");
        this.clearCurrent();
        this.processNext();
      });
  }

}
