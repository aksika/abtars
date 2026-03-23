/**
 * cron-checker — heartbeat task that fires due cron entries.
 *
 * Reminders → pending_reminders.json (picked up by main.ts message loop)
 * Tasks     → spawns kiro-cli subprocess, calls onTaskComplete callback
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { logInfo, logWarn } from "./logger.js";
import { CronExpressionParser } from "cron-parser";
import type { CronEntry } from "../cli/agentbridge-cron.js";

const TAG = "cron-checker";
const memoryDir = (): string => join(homedir(), ".agentbridge", "memory");
const cronPath = (): string => join(memoryDir(), "cron.json");
const remindersPath = (): string => join(memoryDir(), "pending_reminders.json");

export interface PendingReminder {
  chatId: number;
  message: string;
  createdAt: number;
  threadId?: number;
}

function readCron(): CronEntry[] {
  if (!existsSync(cronPath())) return [];
  try { return JSON.parse(readFileSync(cronPath(), "utf-8")) as CronEntry[]; }
  catch { return []; }
}

function writeCron(entries: CronEntry[]): void {
  writeFileSync(cronPath(), JSON.stringify(entries, null, 2), "utf-8");
}

export function readPendingReminders(): PendingReminder[] {
  if (!existsSync(remindersPath())) return [];
  try { return JSON.parse(readFileSync(remindersPath(), "utf-8")) as PendingReminder[]; }
  catch { return []; }
}

export function clearPendingReminders(): void {
  if (existsSync(remindersPath())) writeFileSync(remindersPath(), "[]", "utf-8");
}

function appendReminder(r: PendingReminder): void {
  mkdirSync(memoryDir(), { recursive: true });
  const existing = readPendingReminders();
  existing.push(r);
  writeFileSync(remindersPath(), JSON.stringify(existing, null, 2), "utf-8");
}

const MAX_HISTORY = 10;
const GC_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Record a run in the entry's history (keeps last MAX_HISTORY). */
function recordRun(entry: CronEntry, exitCode?: number): void {
  if (!entry.history) entry.history = [];
  entry.history.push({ ts: Date.now(), ...(exitCode !== undefined ? { exitCode } : {}) });
  if (entry.history.length > MAX_HISTORY) entry.history = entry.history.slice(-MAX_HISTORY);
}

const RETRY_DELAY_MS = 10 * 60 * 1000; // 2 heartbeat cycles (10 min)

/**
 * Check cron.json for due entries. Fire reminders to pending_reminders.json,
 * spawn tasks as kiro-cli subprocesses. Recurring entries reschedule after firing.
 * GCs fired one-shots older than 7 days.
 */
export function checkCron(onTaskComplete?: (chatId: number, message: string, result: string) => void): boolean {
  let entries = readCron();
  const now = Date.now();
  let changed = false;
  let firedTask = false;

  // GC: remove fired one-shots older than 7 days
  const before = entries.length;
  entries = entries.filter(e => !(e.fired && !e.schedule && now - e.createdAt > GC_AGE_MS));
  if (entries.length < before) {
    changed = true;
    logInfo(TAG, `🗑️ GC: pruned ${before - entries.length} old fired entries`);
  }

  for (const entry of entries) {
    // Check for retry (failed task, 2 cycles later)
    const isRetry = entry.retryAfter && entry.retryAfter <= now;
    if (isRetry) {
      delete entry.retryAfter;
      changed = true;
      logInfo(TAG, `🔄 Retrying failed entry: "${entry.message.slice(0, 60)}"`);
      // fall through to fire
    } else if (entry.fired || entry.paused || entry.fireAt > now) {
      continue;
    } else {
      // Normal fire
      entry.lastRanAt = now;

      if (entry.schedule) {
        try {
          const expr = CronExpressionParser.parse(entry.schedule);
          entry.fireAt = expr.next().getTime();
        } catch {
          entry.fired = true;
        }
      } else {
        entry.fired = true;
      }
      changed = true;
    }

    if (entry.type === "reminder") {
      appendReminder({ chatId: entry.chatId, message: entry.message, createdAt: now });
      recordRun(entry);
      logInfo(TAG, `⏰ Reminder fired: "${entry.message}" → chat ${entry.chatId}`);
      continue; // reminders don't count toward 1-task-per-tick
    } else if (firedTask) {
      break; // 1 task per tick — remaining overdue entries wait for next tick
    } else if (entry.executor === "script") {
      // Script task: run command directly via bash
      logInfo(TAG, `📜 Script task fired: "${entry.message}"`);
      const capturedEntry = entry;
      const wasRetry = isRetry;
      try {
        const child = spawn("bash", ["-c", entry.message], { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
        child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
        child.on("exit", (code) => {
          const summary = output.slice(0, 500) || "(no output)";
          const status = code === 0 ? "✅" : `❌ (exit ${code})`;
          logInfo(TAG, `📜 Script task ${status}: "${capturedEntry.message}"`);
          recordRun(capturedEntry, code ?? undefined);
          if (code !== 0 && !wasRetry) {
            capturedEntry.retryAfter = Date.now() + RETRY_DELAY_MS;
            logInfo(TAG, `🔄 Will retry in 10min: "${capturedEntry.message.slice(0, 60)}"`);
          }
          writeCron(readCron().map(e => e.id === capturedEntry.id ? capturedEntry : e));
          onTaskComplete?.(capturedEntry.chatId, capturedEntry.message, `${status}\n${summary}`);
        });
        child.on("error", (err) => {
          logWarn(TAG, `Script spawn failed: ${err.message}`);
          recordRun(capturedEntry, 1);
          writeCron(readCron().map(e => e.id === capturedEntry.id ? capturedEntry : e));
          onTaskComplete?.(capturedEntry.chatId, capturedEntry.message, `❌ Failed to execute: ${err.message}`);
        });
      } catch (err) {
        logWarn(TAG, `Script spawn error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // Agent task: spawn kiro-cli to execute
      logInfo(TAG, `⚙️ Task fired: "${entry.message}" → spawning subagent`);
      const capturedEntry = entry;
      const wasRetry = isRetry;
      try {
        const child = spawn("kiro-cli", ["acp", "--agent", "professor"], { stdio: ["pipe", "pipe", "ignore"] });
        let output = "";
        child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
        child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "sendPrompt", params: { prompt: entry.message }, id: 1 }) + "\n");
        child.stdin?.end();
        child.on("exit", (code) => {
          const summary = output.slice(0, 500) || "(no output)";
          logInfo(TAG, `⚙️ Task completed: "${capturedEntry.message}"`);
          recordRun(capturedEntry, code ?? undefined);
          if (code !== 0 && !wasRetry) {
            capturedEntry.retryAfter = Date.now() + RETRY_DELAY_MS;
            logInfo(TAG, `🔄 Will retry in 10min: "${capturedEntry.message.slice(0, 60)}"`);
          }
          writeCron(readCron().map(e => e.id === capturedEntry.id ? capturedEntry : e));
          onTaskComplete?.(capturedEntry.chatId, capturedEntry.message, summary);
        });
        child.on("error", (err) => {
          logWarn(TAG, `Task spawn failed: ${err.message}`);
          recordRun(capturedEntry, 1);
          writeCron(readCron().map(e => e.id === capturedEntry.id ? capturedEntry : e));
          onTaskComplete?.(capturedEntry.chatId, capturedEntry.message, `❌ Failed to execute: ${err.message}`);
        });
      } catch (err) {
        logWarn(TAG, `Task spawn error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    firedTask = true;
  }

  if (changed) writeCron(entries);
  return firedTask;
}

// --- Browse task checker ---

import { readPendingBrowse, writePendingBrowse } from "../cli/agentbridge-browse.js";
import type { PendingBrowseEntry } from "../cli/agentbridge-browse.js";

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/** Extract full agent response text from ACP JSON-RPC log. */
function extractAgentText(logFile: string): string {
  try {
    if (!existsSync(logFile)) return "";
    const content = readFileSync(logFile, "utf-8");
    const chunks: string[] = [];
    for (const line of content.split("\n")) {
      try {
        const msg = JSON.parse(line);
        if (msg.method === "session/update" && msg.params?.update?.sessionUpdate === "agent_message_chunk") {
          const text = msg.params.update.content?.text;
          if (text) chunks.push(text);
        }
      } catch { /* skip non-JSON */ }
    }
    return chunks.join("");
  } catch { return ""; }
}

const subagentsDir = (): string => join(homedir(), ".agentbridge", "subagents");

/** Ensure report file exists in subagents dir. Returns the file path. */
function ensureReportFile(taskId: string): string {
  const dir = subagentsDir();
  mkdirSync(dir, { recursive: true });

  // Check if agent already wrote the file
  try {
    const existing = readdirSync(dir).find(f => f.startsWith(`browse_${taskId}`));
    if (existing) return join(dir, existing);
  } catch { /* */ }

  // Fallback: extract from log and write
  const logFile = join(homedir(), ".agentbridge", "logs", `browse_${taskId}.log`);
  const text = extractAgentText(logFile);
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = join(dir, `browse_${taskId}_${date}.md`);
  writeFileSync(reportPath, text || "(no output captured)", "utf-8");
  return reportPath;
}

/**
 * Check pending browse tasks. Deliver results for completed/timed-out tasks.
 */
export function checkBrowseTasks(): void {
  const entries = readPendingBrowse();
  if (entries.length === 0) return;

  const now = Date.now();
  const remaining: PendingBrowseEntry[] = [];

  for (const entry of entries) {
    const alive = isProcessAlive(entry.pid);
    const elapsed = now - entry.startedAt;

    if (!alive) {
      // Process finished — ensure report file exists, notify with path
      const reportPath = ensureReportFile(entry.taskId);
      const taskLabel = entry.task.length > 200 ? entry.task.slice(0, 200) + "…" : entry.task;
      appendReminder({
        chatId: entry.chatId,
        message: `🌐 Browse task complete: ${taskLabel}\nReport: ${reportPath}`,
        createdAt: now,
        threadId: entry.threadId,
      });
      logInfo(TAG, `🌐 Browse task "${taskLabel}" finished — report: ${reportPath}`);
    } else if (elapsed > entry.timeoutMs) {
      // Timed out — kill, save partial, notify
      try { process.kill(entry.pid, "SIGKILL"); } catch { /* already dead */ }
      const reportPath = ensureReportFile(entry.taskId);
      const taskLabel = entry.task.length > 200 ? entry.task.slice(0, 200) + "…" : entry.task;
      appendReminder({
        chatId: entry.chatId,
        message: `🌐 Browse task timed out (${Math.round(entry.timeoutMs / 1000)}s): ${taskLabel}\nPartial report: ${reportPath}`,
        createdAt: now,
        threadId: entry.threadId,
      });
      logWarn(TAG, `🌐 Browse task "${taskLabel}" timed out — partial report: ${reportPath}`);
    } else {
      // Still running within timeout — keep
      remaining.push(entry);
    }
  }

  writePendingBrowse(remaining);
}
