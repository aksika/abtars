import { logAndSwallow } from "../log-and-swallow.js";
import { addTaskFailure } from "./task-failure-buffer.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { abtarsHome } from "../../paths.js";
import { logInfo, logWarn } from "../logger.js";
import { readLastPromptAt } from "../transport/bridge-lock-transport.js";
import { incrementFailures, resetFailures, setAutoPaused, setRetrying } from "./task-state-store.js";
import { appendRun } from "./task-history-store.js";
import { kanbanComplete, kanbanFail } from "./kanban-board.js";
import type { ScheduledTask } from "./task-types.js";
import { isSystemEntry, formatTaskLabel } from "./task-types.js";
import { getSystemTaskRegistry } from "./system-task-registry.js";
import { localDate } from "../../utils/date.js";

const TAG = "cron-queue";
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const RETRY_DELAY_MS = 10 * 60 * 1000;
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

function writeResultFile(entryId: string, content: string): string | null {
  try {
    const dir = join(abtarsHome(), "workspace", entryId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${entryId}-${localDate()}.md`);
    writeFileSync(file, content, "utf-8");
    return file;
  } catch (err) { logAndSwallow(TAG, "writeResultFile", err); return null; }
}

const DOD_MIN_BYTES = 100;

function todayStr(): string {
  return localDate();
}

export interface TaskFileResult {
  prompt: string;
  dodPaths: string[];
}

export function readTaskFile(taskFile: string): TaskFileResult | null {
  const filePath = resolve(taskFile.replace(/^~/, homedir()));
  if (!existsSync(filePath)) { logWarn(TAG, `Task file not found: ${filePath}`); return null; }
  const raw = readFileSync(filePath, "utf-8");
  const today = todayStr();
  const content = raw.replace(/\{today\}/g, today);

  const dodIdx = content.indexOf("## Definition of Done");
  let prompt: string;
  let dodPaths: string[] = [];
  if (dodIdx === -1) {
    prompt = content.trim();
  } else {
    prompt = content.slice(0, dodIdx).trim();
    const dodSection = content.slice(dodIdx);
    dodPaths = dodSection.split("\n")
      .filter(l => l.match(/^- /))
      .map(l => l.replace(/^- /, "").trim())
      .filter(p => {
        if (p.length === 0 || p.includes(" ") || p.includes("\t") || (!p.startsWith("/") && !p.startsWith("~"))) {
          logWarn(TAG, `Rejected malformed DoD path: "${p}" — must be absolute or ~/ path`);
          return false;
        }
        return true;
      })
      .map(p => resolve(p.replace(/^~/, homedir())));
  }

  const dir = dirname(filePath);
  const base = basename(filePath, ".md");
  const associated = readdirSync(dir).filter(f => f !== base + ".md" && !f.startsWith(".")).sort();
  if (associated.length > 0) {
    let injected = "\n\n---\n## Associated files\n";
    let totalChars = 0;
    const CAP = 10_000;
    for (const f of associated) {
      const fc = readFileSync(join(dir, f), "utf-8");
      if (totalChars + fc.length > CAP) {
        injected += `\n[${f}]: (truncated — full file at ${join(dir, f)})\n`;
        break;
      }
      injected += `\n### ${f}\n\`\`\`\n${fc}\n\`\`\`\n`;
      totalChars += fc.length;
    }
    prompt += injected;
  }

  return { prompt, dodPaths };
}

function checkDoD(paths: string[]): { passed: boolean; details: string } {
  if (paths.length === 0) return { passed: true, details: "no DoD defined" };
  const results: string[] = [];
  let allPassed = true;
  for (const p of paths) {
    let size: number | null = null;
    if (existsSync(p)) {
      size = statSync(p).size;
    } else {
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(remaining, 200));
        if (existsSync(p)) { size = statSync(p).size; break; }
      }
    }
    if (size === null) {
      results.push(`✗ missing: ${p}`);
      allPassed = false;
    } else if (size < DOD_MIN_BYTES) {
      results.push(`✗ too small (${size}B): ${p}`);
      allPassed = false;
    } else {
      results.push(`✓ ${p} (${size}B)`);
    }
  }
  return { passed: allPassed, details: results.join("\n") };
}

function scheduleRetry(entry: ScheduledTask, isRetry: boolean): void {
  if (!entry.schedule || isRetry) return;
  setRetrying(entry.id, true, Date.now() + RETRY_DELAY_MS);
  logInfo(TAG, `Scheduled retry for "${entry.id}" in ${RETRY_DELAY_MS / 60000}min`);
}

function recordSettledRun(entry: ScheduledTask, outcome: "success" | "failed" | "noop" | "deferred" | "skipped", startedAt: number, detail?: string, resultPath?: string, kanbanCardId?: number): void {
  appendRun({
    taskId: entry.id,
    kind: entry.kind,
    trigger: "schedule",
    startedAt,
    finishedAt: Date.now(),
    outcome,
    detail,
    resultPath,
    kanbanCardId,
  });
}

export type TaskCompleteCallback = (chatId: number, message: string, result: string, dodFiles?: string[]) => void;
export type FailInjectCallback = (entryId: string, command: string, result: string) => void;
export type TaskPausedCallback = (chatId: number, title: string, reason: string) => void;

interface QueuedJob {
  entry: ScheduledTask;
  onComplete?: TaskCompleteCallback;
  manual?: boolean;
}

export interface RunningJob {
  entryId: string;
  message: string;
  pid: number;
  startedAt: number;
  type: "script" | "agent" | "system";
}

export class CronQueue {
  private queue: QueuedJob[] = [];
  private _current: RunningJob | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private readonly onFailInject?: FailInjectCallback;
  private readonly onTaskPaused?: TaskPausedCallback;
  private readonly failCounts = new Map<string, { date: string; count: number }>();

  constructor(_cliPath: string, _workingDir: string, onFailInject?: FailInjectCallback, onTaskPaused?: TaskPausedCallback) {
    this.onFailInject = onFailInject;
    this.onTaskPaused = onTaskPaused;
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

  enqueue(entry: ScheduledTask, onComplete?: TaskCompleteCallback, manual?: boolean): string | null {
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
    this.queue.splice(i, 0, { entry, onComplete, manual });
    logInfo(TAG, `Enqueued "${entry.id}" (${entry.kind}, ${entry.priority ?? "medium"}${manual ? ", manual" : ""}) — ${this.queue.length} pending`);
    persistState(this._current, this.queue);

    if (!this._current) this.processNext();
    return null;
  }

  private processNext(): void {
    if (this.queue.length === 0) return;
    const job = this.queue.shift()!;
    const { entry } = job;

    if (isSystemEntry(entry)) {
      this.runSystem(entry);
    } else if (entry.kind === "script") {
      this.runScript(entry, job.onComplete);
    } else if (entry.kind === "orc") {
      this.runOrc(entry);
    } else if (entry.kind === "agent") {
      this.runAgent(entry, job.onComplete, job.manual);
    } else if (entry.kind === "reminder") {
      logInfo(TAG, `Reminder "${entry.id}" already delivered — skipping`);
      this.processNext();
    }
  }

  private setCurrent(entry: ScheduledTask, pid: number, type: "script" | "agent" | "system"): void {
    this._current = {
      entryId: entry.id,
      message: getEntryMessage(entry).slice(0, 80),
      pid,
      startedAt: Date.now(),
      type,
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
      logWarn(TAG, `⏸ Auto-paused "${entry.id}" after ${count} consecutive failures`);
      this.onTaskPaused?.(parseInt(entry.chatId ?? "0", 10), formatTaskLabel(entry.id), lastError.slice(0, 200));
      return true;
    }
    return false;
  }

  private async runSystem(entry: ScheduledTask & { kind: "system" }): Promise<void> {
    logInfo(TAG, `▶ System: "${entry.action}" (${entry.id})`);
    this.setCurrent(entry, 0, "system");
    try {
      const result = await getSystemTaskRegistry().dispatch(entry);
      if (result.status === "deferred") {
        recordSettledRun(entry, "deferred", this._current?.startedAt ?? Date.now(), result.detail);
        logInfo(TAG, `⏸ Deferred: "${entry.action}" (${entry.id}) — retry at ${new Date(result.retryAt).toISOString()}: ${result.detail}`);
        setRetrying(entry.id, true, result.retryAt);
      } else if (result.status === "noop") {
        recordSettledRun(entry, "noop", this._current?.startedAt ?? Date.now(), result.detail);
        const detail = result.detail ? ` — ${result.detail}` : "";
        logInfo(TAG, `■ System noop: "${entry.action}" (${entry.id})${detail}`);
      } else {
        const ok = result.status === "accepted";
        const detail = ok ? (result as { status: "accepted"; detail?: string }).detail : (result as { status: "failed"; error: string }).error;
        recordSettledRun(entry, ok ? "success" : "failed", this._current?.startedAt ?? Date.now(), detail);
        logInfo(TAG, `■ System ${ok ? "✓" : "❌"}: "${entry.action}" (${entry.id})${detail ? ` — ${detail}` : ""}`);
        if (!ok) {
          this.checkAutoPause(entry, 1, detail ?? "");
          scheduleRetry(entry, false);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `System dispatch error for "${entry.action}": ${msg}`);
      recordSettledRun(entry, "failed", this._current?.startedAt ?? Date.now(), msg);
      this.checkAutoPause(entry, 1, msg);
      scheduleRetry(entry, false);
    } finally {
      this.clearCurrent();
      this.processNext();
    }
  }

  private runOrc(entry: ScheduledTask & { kind: "orc" }): void {
    logInfo(TAG, `▶ Orc: "${entry.goal.slice(0, 60)}"`);
    import("../spin.js").then(({ spin }) => {
      spin.dispatch({ type: "O", goal: entry.goal, source: "task", priority: entry.priority ?? "MEDIUM" });
      this.clearCurrent();
      this.processNext();
    }).catch((err) => {
      logWarn(TAG, `Orc dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      this.clearCurrent();
      this.processNext();
    });
  }

  private runScript(entry: ScheduledTask & { kind: "script" }, onComplete?: TaskCompleteCallback): void {
    logInfo(TAG, `▶ Script: "${entry.command.slice(0, 60)}"`);
    try {
      const child = spawn("bash", ["-c", entry.command], { stdio: ["ignore", "pipe", "pipe"] });
      this.setCurrent(entry, child.pid ?? 0, "script");

      let output = "";
      child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

      child.on("exit", (code) => {
        const status = code === 0 ? "✓" : `❌ (exit ${code})`;
        logInfo(TAG, `■ Script ${status}: "${entry.command.slice(0, 60)}"`);
        recordSettledRun(entry, code === 0 ? "success" : "failed", this._current?.startedAt ?? Date.now(), output.slice(0, 200));
        const paused = this.checkAutoPause(entry, code ?? 1, (output || "(no output)").slice(0, 200));
        const followUp = entry.followUp;
        if (code === 0 && output.trim() && followUp) {
          logInfo(TAG, `■ Gate triggered → enqueuing agent follow-up for "${entry.id}"`);
          this.clearCurrent();
          const agentPrompt = followUp.prompt.replace("{{GATE_OUTPUT}}", output.trim());
          const agentEntry: ScheduledTask = {
            id: entry.id + "-followup",
            enabled: true,
            priority: "medium",
            delivery: "silent",
            kind: "agent",
            prompt: agentPrompt,
          };
          this.enqueue(agentEntry, onComplete);
          return;
        }
        if (code !== 0) {
          scheduleRetry(entry, false);
          if (!paused) this.tryInjectFailure(entry, `${status}\n${(output || "(no output)").slice(0, 500)}`);
          addTaskFailure({ taskName: formatTaskLabel(entry.id), exitCode: code ?? 1, error: (output || "").slice(0, 100), timestamp: Date.now(), consecutiveFailures: 1 });
        }
        if (!paused) {
          if (code !== 0 || output.trim()) {
            onComplete?.(parseInt(entry.chatId ?? "0", 10), entry.command, `${status}\n${(output || "(no output)").slice(0, 500)}`);
          }
        }
        this.clearCurrent();
        this.processNext();
      });

      child.on("error", (err) => {
        logWarn(TAG, `Script spawn failed: ${err.message}`);
        onComplete?.(parseInt(entry.chatId ?? "0", 10), entry.command, `❌ Failed: ${err.message}`);
        this.clearCurrent();
        this.processNext();
      });
    } catch (err) {
      logWarn(TAG, `Script error: ${err instanceof Error ? err.message : String(err)}`);
      this.clearCurrent();
      this.processNext();
    }
  }

  private async runAgent(entry: ScheduledTask & { kind: "agent" }, onComplete?: TaskCompleteCallback, manual?: boolean): Promise<void> {
    if (!manual) {
      const idleMs = Date.now() - readLastPromptAt();
      if (idleMs < 90_000) {
        logInfo(TAG, `⏸ Deferring agent task "${entry.id}" — user active ${Math.round(idleMs / 1000)}s ago`);
        const count = incrementFailures(entry.id);
        if (count >= 3) {
          setAutoPaused(entry.id, true);
          logWarn(TAG, `⏸ Auto-paused "${entry.id}" after ${count} idle-gate deferrals`);
          this.onTaskPaused?.(parseInt(entry.chatId ?? "0", 10), formatTaskLabel(entry.id), `idle-gate hit ${count}× in a row`);
        }
        scheduleRetry(entry, false);
        this.clearCurrent();
        this.processNext();
        return;
      }
    }

    let prompt = entry.prompt ?? "";
    let dodPaths: string[] = [];
    if (entry.taskFile) {
      const task = readTaskFile(entry.taskFile);
      if (task) {
        prompt = task.prompt;
        dodPaths = task.dodPaths;
      } else {
        logWarn(TAG, `Falling back to inline message for "${entry.id}"`);
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

    logInfo(TAG, `▶ Agent: "${(entry.prompt ?? entry.taskFile ?? "").slice(0, 60)}"`);

    if (entry.targetUserId) {
      this.setCurrent(entry, 0, "agent");
      try {
        const { spin } = await import("../spin.js");
        const response = await spin.injectGreeting(entry.targetUserId, prompt);
        if (response) {
          recordSettledRun(entry, "success", this._current?.startedAt ?? Date.now());
          logInfo(TAG, `✓ Greeting delivered to ${entry.targetUserId}`);
        } else {
          recordSettledRun(entry, "failed", this._current?.startedAt ?? Date.now(), "greeting returned no response");
          logWarn(TAG, `Greeting failed for ${entry.targetUserId}`);
        }
      } catch (err) {
        recordSettledRun(entry, "failed", this._current?.startedAt ?? Date.now(), err instanceof Error ? err.message : String(err));
        logWarn(TAG, `Greeting error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.clearCurrent();
        this.processNext();
      }
      return;
    }

    this.setCurrent(entry, 0, "agent");

    const workspace = join(abtarsHome(), "workspace", entry.id);
    mkdirSync(workspace, { recursive: true });
    process.env["WORKSPACE"] = workspace;

    const { spin } = await import("../spin.js");

    this.timeout = setTimeout(() => {
      logWarn(TAG, `⏱️ Agent "${entry.id}" timed out (30min)`);
    }, AGENT_TIMEOUT_MS);

    const AGENT_SESSION: Record<string, string> = { professor: "A", browsie: "B", coding: "C", dreamy: "D" };
    const sessionType = (AGENT_SESSION[entry.agent ?? ""] ?? "T") as import("../spin-types.js").SessionType;

    spin.dispatchAwait({
      type: sessionType,
      title: formatTaskLabel(entry.id),
      goal: prompt,
      source: "task",
      priority: entry.priority ?? "MEDIUM",
      chatId: String(entry.chatId),
      maxToolRounds: entry.maxToolRounds,
    })
      .then(({ cardId: boardId, result: response }) => {
        let cleaned = response || "(no output)";
        try {
          const parsed = JSON.parse(cleaned);
          if (parsed && typeof parsed === "object" && "exit_code" in parsed) {
            cleaned = parsed.stdout || parsed.stderr || "(task completed)";
          }
        } catch (err) { logAndSwallow(TAG, "JSON.parse task output", err); }
        const summary = cleaned.slice(0, 500);
        let exitCode = 0;
        let dodResult = "";
        if (dodPaths.length > 0) {
          const dod = checkDoD(dodPaths);
          exitCode = dod.passed ? 0 : 1;
          dodResult = `\nDoD: ${dod.passed ? "PASSED" : "FAILED"}\n${dod.details}`;
          logInfo(TAG, `■ Agent DoD ${dod.passed ? "✓" : "❌"}: "${(entry.prompt ?? entry.taskFile ?? "").slice(0, 60)}"\n${dod.details}`);
        } else {
          logInfo(TAG, `■ Agent completed: "${(entry.prompt ?? entry.taskFile ?? "").slice(0, 60)}"`);
        }

        const producedFiles = dodPaths.filter(p => existsSync(p));
        const isReport = entry.delivery === "report";
        const resultPath = producedFiles.length > 0 ? producedFiles[0] : (isReport ? writeResultFile(entry.id, cleaned) : null);
        if (resultPath) logInfo(TAG, `■ Result: ${resultPath}`);

        if (exitCode === 0) {
          const kanbanSummary = isReport ? summary : cleaned;
          kanbanComplete(boardId, resultPath ?? null, kanbanSummary);
        } else {
          kanbanFail(boardId, `${summary}${dodResult}`);
        }

        recordSettledRun(entry, exitCode === 0 ? "success" : "failed", this._current?.startedAt ?? Date.now(), `${summary}${dodResult}`, resultPath ?? undefined, boardId);
        const paused = this.checkAutoPause(entry, exitCode, `${summary}${dodResult}`);
        const icon = exitCode === 0 ? "✓" : "❌";
        if (exitCode !== 0) {
          scheduleRetry(entry, false);
          if (!paused) this.tryInjectFailure(entry, `${icon} ${summary}${dodResult}`);
        }
        if (!paused) {
          const producedFiles = dodPaths.filter(p => existsSync(p));
          onComplete?.(parseInt(entry.chatId ?? "0", 10), entry.prompt ?? "", `${icon} ${summary}${dodResult}`, producedFiles.length > 0 ? producedFiles : undefined);
        }
      })
      .catch((err: unknown) => {
        const boardId = 0;
        logWarn(TAG, `Agent failed: ${err instanceof Error ? err.message : String(err)}`);
        kanbanFail(boardId, err instanceof Error ? err.message : String(err));
        recordSettledRun(entry, "failed", this._current?.startedAt ?? Date.now(), err instanceof Error ? err.message : String(err), undefined, boardId);
        const paused = this.checkAutoPause(entry, 1, err instanceof Error ? err.message : String(err));
        scheduleRetry(entry, false);
        if (!paused) {
          const errMsg = `❌ Failed: ${err instanceof Error ? err.message : String(err)}`;
          this.tryInjectFailure(entry, errMsg);
          onComplete?.(parseInt(entry.chatId ?? "0", 10), entry.prompt ?? "", errMsg);
        }
      })
      .finally(() => {
        this.clearCurrent();
        this.processNext();
      });
  }
}
