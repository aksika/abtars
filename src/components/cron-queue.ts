/**
 * CronQueue — sequential job processor for cron tasks.
 *
 * Heartbeat enqueues due tasks. Queue runs them one at a time:
 * scripts sequentially, agents sequentially, never concurrent.
 * Priority-sorted: high jobs jump ahead of pending medium/low.
 * Duplicate prevention: same entry ID can't be queued or running twice.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logInfo, logWarn, logDebug } from "./logger.js";
import type { CronEntry } from "../cli/agentbridge-cron.js";

const TAG = "cron-queue";
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const RETRY_DELAY_MS = 10 * 60 * 1000; // skip 1 cycle (2 × 5min)
const PRIO_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function cronPath(): string { return join(homedir(), ".agentbridge", "memory", "cron.json"); }

/** Schedule a one-time retry after 1 skipped cycle. Only if entry has a schedule (recurring) and hasn't retried yet. */
function scheduleRetry(entry: CronEntry): void {
  if (!entry.schedule || entry._retrying) {
    logInfo(TAG, `No retry for "${entry.id}" — ${entry._retrying ? "already retried" : "one-shot"}`);
    return;
  }
  try {
    const raw = readFileSync(cronPath(), "utf-8");
    const entries: CronEntry[] = JSON.parse(raw);
    const target = entries.find(e => e.id === entry.id);
    if (target) {
      target.fireAt = Date.now() + RETRY_DELAY_MS;
      target.fired = false;
      target._retrying = true;
      writeFileSync(cronPath(), JSON.stringify(entries, null, 2), "utf-8");
      logInfo(TAG, `Scheduled retry for "${entry.id}" in ${RETRY_DELAY_MS / 60000}min`);
    }
  } catch (err) {
    logWarn(TAG, `Failed to schedule retry: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export type TaskCompleteCallback = (chatId: number, message: string, result: string) => void;

interface QueuedJob {
  entry: CronEntry;
  onComplete?: TaskCompleteCallback;
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

  /** Currently running job, or null. */
  get currentJob(): RunningJob | null { return this._current; }

  /** Number of jobs waiting. */
  get pending(): number { return this.queue.length; }

  /** Enqueue a task. Skips if entry ID is already queued or running. */
  enqueue(entry: CronEntry, onComplete?: TaskCompleteCallback): void {
    if (this._current?.entryId === entry.id) {
      logDebug(TAG, `Skip "${entry.id}" — already running`);
      return;
    }
    if (this.queue.some(j => j.entry.id === entry.id)) {
      logDebug(TAG, `Skip "${entry.id}" — already queued`);
      return;
    }

    // Priority-sorted insert
    const rank = PRIO_RANK[entry.priority ?? "medium"] ?? 1;
    let i = 0;
    while (i < this.queue.length) {
      const qRank = PRIO_RANK[this.queue[i]!.entry.priority ?? "medium"] ?? 1;
      if (rank < qRank) break;
      i++;
    }
    this.queue.splice(i, 0, { entry, onComplete });
    logInfo(TAG, `Enqueued "${entry.id}" (${entry.executor ?? "agent"}, ${entry.priority ?? "medium"}) — ${this.queue.length} pending`);

    if (!this._current) this.processNext();
  }

  private processNext(): void {
    if (this.queue.length === 0) return;
    const job = this.queue.shift()!;
    const { entry } = job;

    if (entry.executor === "script") {
      this.runScript(entry, job.onComplete);
    } else {
      this.runAgent(entry, job.onComplete);
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
        if (code !== 0) scheduleRetry(entry);
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

  private runAgent(entry: CronEntry, onComplete?: TaskCompleteCallback): void {
    logInfo(TAG, `▶ Agent: "${entry.message.slice(0, 60)}"`);
    try {
      const child = spawn("kiro-cli", ["acp", "--agent", "professor"], { stdio: ["pipe", "pipe", "ignore"] });
      
      this.setCurrent(entry, child.pid ?? 0, "agent");

      // 30-min hard timeout
      this.timeout = setTimeout(() => {
        logWarn(TAG, `⏱️ Agent "${entry.id}" timed out (30min) — killing pid ${child.pid}`);
        try { child.kill("SIGKILL"); } catch { /* dead */ }
      }, AGENT_TIMEOUT_MS);

      let output = "";
      const send = (obj: unknown): void => { child.stdin?.write(JSON.stringify(obj) + "\n"); };
      let msgId = 0;
      let phase = 0;
      let buf = "";

      send({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "0.1", clientInfo: { name: "agentbridge-cron", version: "0.1.0" }, capabilities: {} }, id: ++msgId });

      child.stdout?.on("data", (d: Buffer) => {
        buf += d.toString();
        output += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (phase === 0 && msg.id) {
              phase = 1;
              send({ jsonrpc: "2.0", method: "session/new", params: { cwd: process.env["WORKING_DIR"] || "." }, id: ++msgId });
            } else if (phase === 1 && msg.result?.sessionId) {
              phase = 2;
              send({ jsonrpc: "2.0", method: "session/prompt", params: { sessionId: msg.result.sessionId, message: entry.message }, id: ++msgId });
              child.stdin?.end();
            }
          } catch { /* not JSON */ }
        }
      });

      child.on("exit", (_code) => {
        const summary = (output || "(no output)").slice(0, 500);
        logInfo(TAG, `■ Agent completed: "${entry.message.slice(0, 60)}"`);
        if (_code !== 0) scheduleRetry(entry);
        onComplete?.(entry.chatId, entry.message, summary);
        this.clearCurrent();
        this.processNext();
      });

      child.on("error", (err) => {
        logWarn(TAG, `Agent spawn failed: ${err.message}`);
        onComplete?.(entry.chatId, entry.message, `❌ Failed: ${err.message}`);
        this.clearCurrent();
        this.processNext();
      });
    } catch (err) {
      logWarn(TAG, `Agent error: ${err instanceof Error ? err.message : String(err)}`);
      this.clearCurrent();
      this.processNext();
    }
  }
}
