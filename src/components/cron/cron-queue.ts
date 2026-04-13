/**
 * CronQueue — sequential job processor for cron tasks.
 *
 * Heartbeat enqueues due tasks. Queue runs them one at a time:
 * scripts sequentially, agents sequentially, never concurrent.
 * Priority-sorted: high jobs jump ahead of pending medium/low.
 * Duplicate prevention: same entry ID can't be queued or running twice.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { agentBridgeHome } from "../../paths.js";
import { logInfo, logWarn } from "../logger.js";
import { readLastPromptAt } from "../transport/bridge-lock-transport.js";
import { recordRun as dbRecordRun, readEntry, writeEntry } from "./cron-db.js";
import type { CronEntry } from "../../cli/agentbridge-task.js";
import { localDate } from "../env-utils.js";

const TAG = "cron-queue";
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const RETRY_DELAY_MS = 10 * 60 * 1000; // skip 1 cycle (2 × 5min)
const PRIO_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function recordRunToFile(entryId: string, exitCode?: number): void {
  dbRecordRun(entryId, exitCode);
}

function writeResultFile(entryId: string, content: string): string | null {
  try {
    const dir = join(agentBridgeHome(), "workspace", "task-results");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${entryId}_${localDate()}.md`);
    writeFileSync(file, content, "utf-8");
    return file;
  } catch { return null; }
}

const DOD_MIN_BYTES = 100;

function todayStr(): string {
  return localDate();
}

/** Read task file, substitute {today}, return { prompt, dodPaths }. */
function readTaskFile(taskFile: string): { prompt: string; dodPaths: string[] } | null {
  const filePath = resolve(taskFile.replace(/^~/, homedir()));
  if (!existsSync(filePath)) { logWarn(TAG, `Task file not found: ${filePath}`); return null; }
  const raw = readFileSync(filePath, "utf-8");
  const today = todayStr();
  const content = raw.replace(/\{today\}/g, today);

  const dodIdx = content.indexOf("## Definition of Done");
  if (dodIdx === -1) return { prompt: content.trim(), dodPaths: [] };

  const prompt = content.slice(0, dodIdx).trim();
  const dodSection = content.slice(dodIdx);
  const dodPaths = dodSection.split("\n")
    .filter(l => l.match(/^- /))
    .map(l => l.replace(/^- /, "").trim())
    .map(p => resolve(p.replace(/^~/, homedir())));

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

export type TaskCompleteCallback = (chatId: number, message: string, result: string) => void;
export type FailInjectCallback = (entryId: string, command: string, result: string) => void;

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
  private readonly failCounts = new Map<string, { date: string; count: number }>();

  constructor(_cliPath: string, _workingDir: string, onFailInject?: FailInjectCallback) {
    this.onFailInject = onFailInject;
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

    if (!this._current) this.processNext();
    return null;
  }

  private processNext(): void {
    if (this.queue.length === 0) return;
    const job = this.queue.shift()!;
    const { entry } = job;

    if (entry.executor === "script") {
      this.runScript(entry, job.onComplete);
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
  }

  private clearCurrent(): void {
    if (this.timeout) { clearTimeout(this.timeout); this.timeout = null; }
    this._current = null;
    
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

  private runScript(entry: CronEntry, onComplete?: TaskCompleteCallback): void {
    logInfo(TAG, `▶ Script: "${entry.message.slice(0, 60)}"`);
    try {
      const child = spawn("bash", ["-c", entry.message], { stdio: ["ignore", "pipe", "pipe"] });
      
      this.setCurrent(entry, child.pid ?? 0, "script");

      let output = "";
      child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

      child.on("exit", (code) => {
        const status = code === 0 ? "✅" : `❌ (exit ${code})`;
        logInfo(TAG, `■ Script ${status}: "${entry.message.slice(0, 60)}"`);
        recordRunToFile(entry.id, code ?? undefined);
        if (code !== 0) {
          scheduleRetry(entry, !!entry._retrying);
          this.tryInjectFailure(entry, `${status}\n${(output || "(no output)").slice(0, 500)}`);
        }
        onComplete?.(entry.chatId, entry.message, `${status}\n${(output || "(no output)").slice(0, 500)}`);
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

    logInfo(TAG, `▶ Agent: "${entry.message.slice(0, 60)}"`);

    const { createSubagentTransport } = await import("../agent-registry.js");
    const { transport } = await createSubagentTransport("cron");
    const sessionKey = `cron:${entry.id}`;

    // 30-min hard timeout
    this.timeout = setTimeout(() => {
      logWarn(TAG, `⏱️ Agent "${entry.id}" timed out (30min) — destroying transport`);
      transport.destroy();
    }, AGENT_TIMEOUT_MS);

    // Use a fake PID — AcpTransport manages the process internally
    this.setCurrent(entry, 0, "agent");

    transport.initialize()
      .then(() => transport.sendPrompt(sessionKey, prompt))
      .then((response) => {
        const summary = (response || "(no output)").slice(0, 500);
        let exitCode = 0;
        let dodResult = "";
        if (dodPaths.length > 0) {
          const dod = checkDoD(dodPaths);
          exitCode = dod.passed ? 0 : 1;
          dodResult = `\nDoD: ${dod.passed ? "PASSED" : "FAILED"}\n${dod.details}`;
          logInfo(TAG, `■ Agent DoD ${dod.passed ? "✅" : "❌"}: "${entry.message.slice(0, 60)}"\n${dod.details}`);
        } else {
          logInfo(TAG, `■ Agent completed: "${entry.message.slice(0, 60)}"`);
        }

        // Write result file
        const resultPath = writeResultFile(entry.id, response || "(no output)");
        if (resultPath) logInfo(TAG, `■ Result: ${resultPath}`);

        recordRunToFile(entry.id, exitCode);
        const icon = exitCode === 0 ? "✅" : "❌";
        if (exitCode !== 0) {
          scheduleRetry(entry, !!entry._retrying);
          this.tryInjectFailure(entry, `${icon} ${summary}${dodResult}`);
        }
        onComplete?.(entry.chatId, entry.message, `${icon} ${summary}${dodResult}`);
      })
      .catch((err) => {
        logWarn(TAG, `Agent failed: ${err instanceof Error ? err.message : String(err)}`);
        recordRunToFile(entry.id, 1);
        scheduleRetry(entry, !!entry._retrying);
        const errMsg = `❌ Failed: ${err instanceof Error ? err.message : String(err)}`;
        this.tryInjectFailure(entry, errMsg);
        onComplete?.(entry.chatId, entry.message, errMsg);
      })
      .finally(() => {
        transport.destroy();
        this.clearCurrent();
        this.processNext();
      });
  }
}
