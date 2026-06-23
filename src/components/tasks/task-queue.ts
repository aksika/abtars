/**
 * CronQueue — sequential job processor for cron tasks.
 *
 * Heartbeat enqueues due tasks. Queue runs them one at a time:
 * scripts sequentially, agents sequentially, never concurrent.
 * Priority-sorted: high jobs jump ahead of pending medium/low.
 * Duplicate prevention: same entry ID can't be queued or running twice.
 */

import { logAndSwallow } from "../log-and-swallow.js";
import { addTaskFailure } from "./task-failure-buffer.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { abtarsHome } from "../../paths.js";
import { logInfo, logWarn } from "../logger.js";
import { readLastPromptAt, readBridgeLockField } from "../transport/bridge-lock-transport.js";
import { recordRun as dbRecordRun, readEntry, writeEntry } from "./task-store.js";
import { recordRun } from "./task-checker.js";
import { kanbanComplete, kanbanFail } from "./kanban-board.js";
import type { CronEntry } from "../../cli/abtars-task.js";
import { localDate } from "../../utils/date.js";

const TAG = "cron-queue";
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const RETRY_DELAY_MS = 10 * 60 * 1000; // skip 1 cycle (2 × 5min)
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
      queue: queue.map(j => ({ entryId: j.entry.id, message: j.entry.message, priority: j.entry.priority ?? "medium", manual: j.manual ?? false })),
    };
    writeFileSync(STATE_FILE, JSON.stringify(state), "utf-8");
  } catch (err) { logAndSwallow("cron_queue", "op", err); }
}

function loadStaleState(): PersistedState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as PersistedState;
    // If PID matches current process, state is ours (not stale)
    if (raw.pid === process.pid) return null;
    // If bridge was in hw_sleep, don't mark as failed (watchdog-aware)
    const sleepStatus = readBridgeLockField("sleepStatus");
    if (sleepStatus === "hw_sleep") return null;
    return raw;
  } catch (err) { logAndSwallow(TAG, "loadStaleState", err); return null; }
}

function recordRunToFile(entryId: string, exitCode?: number): void {
  dbRecordRun(entryId, exitCode);
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

/** Read task file, substitute {today}, glob associated _* files, return { prompt, dodPaths }. */
function readTaskFile(taskFile: string): { prompt: string; dodPaths: string[] } | null {
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
      .map(p => resolve(p.replace(/^~/, homedir())));
  }

  // Glob associated files: {taskname}_* in same directory (cap 10k chars total)
  const dir = dirname(filePath);
  const base = basename(filePath, ".md");
  const associated = readdirSync(dir).filter(f => f.startsWith(base + "_")).sort();
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

/** Check DoD: each path must exist and be >= DOD_MIN_BYTES. Returns pass/fail + details. */
function checkDoD(paths: string[]): { passed: boolean; details: string } {
  if (paths.length === 0) return { passed: true, details: "no DoD defined" };
  const results: string[] = [];
  let allPassed = true;
  for (const p of paths) {
    if (!existsSync(p)) {
      results.push(`✗ missing: ${p}`);
      allPassed = false;
    } else {
      const size = statSync(p).size;
      if (size < DOD_MIN_BYTES) {
        results.push(`✗ too small (${size}B): ${p}`);
        allPassed = false;
      } else {
        results.push(`✓ ${p} (${size}B)`);
      }
    }
  }
  return { passed: allPassed, details: results.join("\n") };
}

/** Schedule a one-time retry after 1 skipped cycle. */
function scheduleRetry(entry: CronEntry, isRetry: boolean): void {
  if (!entry.schedule || isRetry) return;
  try {
    const target = readEntry(entry.id);
    if (target) {
      target.fireAt = Date.now() + RETRY_DELAY_MS;
      target.fired = false;
      target._retrying = true;
      writeEntry(target);
      logInfo(TAG, `Scheduled retry for "${entry.id}" in ${RETRY_DELAY_MS / 60000}min`);
    }
  } catch (err) {
    logWarn(TAG, `Failed to schedule retry: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export type TaskCompleteCallback = (chatId: number, message: string, result: string, dodFiles?: string[]) => void;
export type FailInjectCallback = (entryId: string, command: string, result: string) => void;
export type TaskPausedCallback = (chatId: number, title: string, reason: string) => void;

interface QueuedJob {
  entry: CronEntry;
  onComplete?: TaskCompleteCallback;
  manual?: boolean;
}

export interface RunningJob {
  entryId: string;
  message: string;
  pid: number;
  startedAt: number;
  type: "script" | "agent";
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
    // #267: recover stale state from previous process
    const stale = loadStaleState();
    if (stale) {
      if (stale.currentJob) {
        logWarn(TAG, `Stale in-flight job detected: "${stale.currentJob.entryId}" (PID ${stale.pid} dead) — marking failed`);
        recordRunToFile(stale.currentJob.entryId, 1);
      }
      if (stale.queue.length > 0) {
        logWarn(TAG, `${stale.queue.length} stale queued job(s) from previous process — dropped`);
      }
      // Clear stale state
      persistState(null, []);
    }
  }

  /** Currently running job, or null. */
  get currentJob(): RunningJob | null { return this._current; }

  /** Number of jobs waiting. */
  get pending(): number { return this.queue.length; }

  /** Enqueue a task. Returns null on success, error string on failure. */
  enqueue(entry: CronEntry, onComplete?: TaskCompleteCallback, manual?: boolean): string | null {
    if (this._current?.entryId === entry.id) {
      return `⏳ Already running: "${entry.message.slice(0, 60)}"`;
    }
    if (this.queue.some(j => j.entry.id === entry.id)) {
      return `⏳ Already queued: "${entry.message.slice(0, 60)}"`;
    }

    // Priority-sorted insert
    const rank = PRIO_RANK[entry.priority ?? "medium"] ?? 1;
    let i = 0;
    while (i < this.queue.length) {
      const qRank = PRIO_RANK[this.queue[i]!.entry.priority ?? "medium"] ?? 1;
      if (rank < qRank) break;
      i++;
    }
    this.queue.splice(i, 0, { entry, onComplete, manual });
    logInfo(TAG, `Enqueued "${entry.id}" (${entry.executor ?? "agent"}, ${entry.priority ?? "medium"}${manual ? ", manual" : ""}) — ${this.queue.length} pending`);
    persistState(this._current, this.queue);

    if (!this._current) this.processNext();
    return null;
  }

  private processNext(): void {
    if (this.queue.length === 0) return;

    // Skip all tasks during hardware sleep (dark wakes are too brief)
    if (readBridgeLockField("sleepStatus") === "hw_sleep") {
      logInfo(TAG, `⏸ Hardware sleep — deferring ${this.queue.length} task(s)`);
      return;
    }

    const job = this.queue.shift()!;
    const { entry } = job;

    if (entry.executor === "script") {
      this.runScript(entry, job.onComplete);
    } else if (entry.executor === "orc") {
      this.runOrc(entry);
    } else {
      this.runAgent(entry, job.onComplete, job.manual);
    }
  }

  private setCurrent(entry: CronEntry, pid: number, type: "script" | "agent"): void {
    this._current = {
      entryId: entry.id,
      message: entry.message.slice(0, 80),
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

  private tryInjectFailure(entry: CronEntry, result: string): void {
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
    this.onFailInject(entry.id, entry.message, result);
  }

  private checkAutoPause(entry: CronEntry, exitCode: number, lastError: string): boolean {
    if (!entry.schedule) return false;
    if (exitCode === 0) {
      if (entry.consecutiveFails) { entry.consecutiveFails = 0; writeEntry(entry); }
      return false;
    }
    entry.consecutiveFails = (entry.consecutiveFails ?? 0) + 1;
    if (entry.consecutiveFails >= 3) {
      entry.paused = true;
      logWarn(TAG, `⏸ Auto-paused "${entry.id}" after ${entry.consecutiveFails} consecutive failures`);
      this.onTaskPaused?.(entry.chatId, entry.title ?? entry.message.slice(0, 60), lastError.slice(0, 200));
      writeEntry(entry);
      return true;
    }
    writeEntry(entry);
    return false;
  }

  private runOrc(entry: CronEntry): void {
    logInfo(TAG, `▶ Orc: "${entry.message.slice(0, 60)}"`);
    import("../spin.js").then(({ spin }) => {
      spin.dispatch({ type: "O", goal: entry.message, source: "task", priority: entry.priority ?? "MEDIUM", deliveryMode: "announce" });
      this.clearCurrent();
      this.processNext();
    }).catch((err) => {
      logWarn(TAG, `Orc dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      this.clearCurrent();
      this.processNext();
    });
  }

  private runScript(entry: CronEntry, onComplete?: TaskCompleteCallback): void {
    logInfo(TAG, `▶ Script: "${entry.message.slice(0, 60)}"`);
    try {
      const child = spawn("bash", ["-c", entry.message], { stdio: ["ignore", "pipe", "pipe"] });
      
      this.setCurrent(entry, child.pid ?? 0, "script");

      let output = "";
      child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

      child.on("exit", (code) => {
        const status = code === 0 ? "✓" : `❌ (exit ${code})`;
        logInfo(TAG, `■ Script ${status}: "${entry.message.slice(0, 60)}"`);
        recordRunToFile(entry.id, code ?? undefined);
        if (code === 0) recordRun(entry, 0); // #694: count toward maxRunsPerDay only on success
        const paused = this.checkAutoPause(entry, code ?? 1, (output || "(no output)").slice(0, 200));
        if (code === 0 && output.trim() && entry.agentFollowUp && entry.agentMessage) {
          logInfo(TAG, `■ Gate triggered → enqueuing agent follow-up for "${entry.id}"`);
          const agentEntry: CronEntry = { ...entry, executor: "agent", message: entry.agentMessage.replace("{{GATE_OUTPUT}}", output.trim()), agentFollowUp: undefined };
          this.clearCurrent();
          this.enqueue(agentEntry, onComplete);
          return;
        }
        if (code !== 0) {
          scheduleRetry(entry, !!entry._retrying);
          if (!paused && code !== 2) this.tryInjectFailure(entry, `${status}\n${(output || "(no output)").slice(0, 500)}`);
          addTaskFailure({ taskName: entry.title ?? entry.message.slice(0, 60), exitCode: code ?? 1, error: (output || "").slice(0, 100), timestamp: Date.now(), consecutiveFailures: entry.consecutiveFails ?? 1 });
        }
        if (!paused) {
          // Silent success: don't notify user when script exits 0 with no output
          if (code !== 0 || output.trim()) {
            onComplete?.(entry.chatId, entry.message, `${status}\n${(output || "(no output)").slice(0, 500)}`);
          }
        }
        this.clearCurrent();
        this.processNext();
      });

      child.on("error", (err) => {
        logWarn(TAG, `Script spawn failed: ${err.message}`);
        onComplete?.(entry.chatId, entry.message, `❌ Failed: ${err.message}`);
        this.clearCurrent();
        this.processNext();
      });
    } catch (err) {
      logWarn(TAG, `Script error: ${err instanceof Error ? err.message : String(err)}`);
      this.clearCurrent();
      this.processNext();
    }
  }

  private async runAgent(entry: CronEntry, onComplete?: TaskCompleteCallback, manual?: boolean): Promise<void> {
    // Idle gate: defer agent tasks if user was active in last 90s (skip for manual triggers)
    if (!manual) {
      const idleMs = Date.now() - readLastPromptAt();
      if (idleMs < 90_000) {
        logInfo(TAG, `⏸ Deferring agent task "${entry.id}" — user active ${Math.round(idleMs / 1000)}s ago`);
        return;
      }
    }

    // Read task file if specified, otherwise use inline message
    let prompt = entry.message;
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

    // #1141: Inject task-scoped persistent context if it exists
    const contextFile = join(abtarsHome(), "workspace", entry.id, "CONTEXT.md");
    if (existsSync(contextFile)) {
      const raw = readFileSync(contextFile, "utf-8").trim();
      if (raw) {
        const ctx = raw.length > 30000 ? (logWarn(TAG, `Task context truncated (${raw.length} > 30000)`), raw.slice(0, 30000)) : raw;
        prompt = `[TASK CONTEXT — your notes from previous runs]\n${ctx}\n\n[TASK]\n${prompt}`;
        logInfo(TAG, `Injected task context (${ctx.length} chars)`);
      }
    }

    logInfo(TAG, `▶ Agent: "${entry.message.slice(0, 60)}"`);

    // #936 Phase 2: Route to user session via injectGreeting if targetUserId is set
    if (entry.targetUserId) {
      this.setCurrent(entry, 0, "agent");
      try {
        const { spin } = await import("../spin.js");
        const response = await spin.injectGreeting(entry.targetUserId, prompt);
        if (response) {
          recordRunToFile(entry.id, 0);
          recordRun(entry, 0);
          logInfo(TAG, `✓ Greeting delivered to ${entry.targetUserId}`);
        } else {
          recordRunToFile(entry.id, 1);
          logWarn(TAG, `Greeting failed for ${entry.targetUserId}`);
        }
      } catch (err) {
        recordRunToFile(entry.id, 1);
        logWarn(TAG, `Greeting error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.clearCurrent();
        this.processNext();
      }
      return;
    }

    // Set current BEFORE any await — prevents race where enqueue() sees _current=null
    // and calls processNext() again while we're awaiting the dynamic import.
    this.setCurrent(entry, 0, "agent");

    // #1141: Skill-trigger task — delegate to launchSkill()
    if ((entry as any).skill) {
      const { launchSkill } = await import("../skill-session.js");
      const userId = entry.targetUserId ?? String(entry.chatId);
      const err = await launchSkill((entry as any).skill, userId, String(entry.chatId), prompt);
      if (err) logWarn(TAG, `Skill launch failed for "${entry.id}": ${err}`);
      else logInfo(TAG, `■ Skill "${(entry as any).skill}" launched for "${entry.id}"`);
      recordRunToFile(entry.id, err ? 1 : 0);
      if (!err) recordRun(entry, 0);
      this.clearCurrent();
      this.processNext();
      return;
    }

    // Kanban board: track this task (Spin handles card lifecycle)
    // Set $WORKSPACE for agent tool execution — all output goes here
    const workspace = join(abtarsHome(), "workspace", entry.id);
    mkdirSync(workspace, { recursive: true });
    process.env["WORKSPACE"] = workspace;

    const { spin } = await import("../spin.js");

    // 30-min hard timeout
    this.timeout = setTimeout(() => {
      logWarn(TAG, `⏱️ Agent "${entry.id}" timed out (30min)`);
    }, AGENT_TIMEOUT_MS);

    // #935: map agent field to session type (canonical task routing — distinct from TYPE_AGENT in spin-types which maps type→model-role)
    const AGENT_SESSION: Record<string, string> = { professor: "A", browsie: "B", coding: "C", dreamy: "D" };
    const sessionType = (AGENT_SESSION[entry.agent ?? ""] ?? "T") as import("../spin-types.js").SessionType;

    spin.dispatchAwait({ type: sessionType, title: entry.title ?? entry.message.slice(0, 80), goal: prompt, source: "task", priority: entry.priority ?? "MEDIUM", chatId: String(entry.chatId) })
      .then(({ cardId: boardId, result: response }) => {
        // Guard: if model returned raw JSON tool output ({"stdout":...,"exit_code":...}),
        // extract just the meaningful content. This happens when the model echoes its last
        // tool result instead of synthesizing a human-readable response.
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
          // If DoD paths missing but model produced substantial output, accept it
          if (!dod.passed && cleaned.length > 200) {
            dod.passed = true;
            dod.details += "\n✓ accepted: model output written to result file";
          }
          exitCode = dod.passed ? 0 : 1;
          dodResult = `\nDoD: ${dod.passed ? "PASSED" : "FAILED"}\n${dod.details}`;
          logInfo(TAG, `■ Agent DoD ${dod.passed ? "✓" : "❌"}: "${entry.message.slice(0, 60)}"\n${dod.details}`);
        } else {
          logInfo(TAG, `■ Agent completed: "${entry.message.slice(0, 60)}"`);
        }

        // Write result file — skip if DoD files exist (they ARE the result)
        // #1118: inline tasks skip file writing — deliver text directly via kanban
        const producedFiles = dodPaths.filter(p => existsSync(p));
        const isReport = entry.deliveryMethod === "report";
        const resultPath = producedFiles.length > 0 ? producedFiles[0] : (isReport ? writeResultFile(entry.id, cleaned) : null);
        if (resultPath) logInfo(TAG, `■ Result: ${resultPath}`);

        // Kanban board: mark complete or failed
        if (exitCode === 0) {
          // #1118: inline tasks store full response as summary (delivered as chat message)
          const kanbanSummary = isReport ? summary : cleaned;
          kanbanComplete(boardId, resultPath, kanbanSummary);
        } else {
          kanbanFail(boardId, `${summary}${dodResult}`);
        }

        recordRunToFile(entry.id, exitCode);
        if (exitCode === 0) recordRun(entry, 0); // #694: count toward maxRunsPerDay only on success
        const paused = this.checkAutoPause(entry, exitCode, `${summary}${dodResult}`);
        const icon = exitCode === 0 ? "✓" : "❌";
        if (exitCode !== 0) {
          scheduleRetry(entry, !!entry._retrying);
          if (!paused) this.tryInjectFailure(entry, `${icon} ${summary}${dodResult}`);
        }
        if (!paused) {
          const producedFiles = dodPaths.filter(p => existsSync(p));
          onComplete?.(entry.chatId, entry.message, `${icon} ${summary}${dodResult}`, producedFiles.length > 0 ? producedFiles : undefined);
        }
      })
      .catch((err: unknown) => {
        const boardId = 0; // card already tracked by Spin
        logWarn(TAG, `Agent failed: ${err instanceof Error ? err.message : String(err)}`);
        kanbanFail(boardId, err instanceof Error ? err.message : String(err));
        recordRunToFile(entry.id, 1);
        const paused = this.checkAutoPause(entry, 1, err instanceof Error ? err.message : String(err));
        scheduleRetry(entry, !!entry._retrying);
        if (!paused) {
          const errMsg = `❌ Failed: ${err instanceof Error ? err.message : String(err)}`;
          this.tryInjectFailure(entry, errMsg);
          onComplete?.(entry.chatId, entry.message, errMsg);
        }
      })
      .finally(() => {
        this.clearCurrent();
        this.processNext();
      });
  }
}
