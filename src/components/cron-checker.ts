/**
 * cron-checker — heartbeat task that fires due cron entries.
 *
 * Reminders → pending_reminders.json (picked up by main.ts message loop)
 * Tasks     → spawns kiro-cli subprocess, calls onTaskComplete callback
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { logInfo, logWarn } from "./logger.js";
import type { CronEntry } from "../cli/agentbridge-cron.js";

const TAG = "cron-checker";
const memoryDir = (): string => join(homedir(), ".agentbridge", "memory");
const cronPath = (): string => join(memoryDir(), "cron.json");
const remindersPath = (): string => join(memoryDir(), "pending_reminders.json");

export interface PendingReminder {
  chatId: number;
  message: string;
  createdAt: number;
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

/**
 * Check cron.json for due entries. Fire reminders to pending_reminders.json,
 * spawn tasks as kiro-cli subprocesses.
 */
export function checkCron(onTaskComplete?: (chatId: number, message: string, result: string) => void): void {
  const entries = readCron();
  const now = Date.now();
  let changed = false;

  for (const entry of entries) {
    if (entry.fired || entry.fireAt > now) continue;

    entry.fired = true;
    changed = true;

    if (entry.type === "reminder") {
      appendReminder({ chatId: entry.chatId, message: entry.message, createdAt: now });
      logInfo(TAG, `⏰ Reminder fired: "${entry.message}" → chat ${entry.chatId}`);
    } else {
      // Task: spawn kiro-cli to execute
      logInfo(TAG, `⚙️ Task fired: "${entry.message}" → spawning subagent`);
      try {
        const child = spawn("kiro-cli", ["acp", "--agent", "professor"], { stdio: ["pipe", "pipe", "ignore"] });
        let output = "";
        child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
        child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "sendPrompt", params: { prompt: entry.message }, id: 1 }) + "\n");
        child.stdin?.end();
        child.on("exit", () => {
          const summary = output.slice(0, 500) || "(no output)";
          logInfo(TAG, `⚙️ Task completed: "${entry.message}"`);
          onTaskComplete?.(entry.chatId, entry.message, summary);
        });
        child.on("error", (err) => {
          logWarn(TAG, `Task spawn failed: ${err.message}`);
          onTaskComplete?.(entry.chatId, entry.message, `❌ Failed to execute: ${err.message}`);
        });
      } catch (err) {
        logWarn(TAG, `Task spawn error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (changed) writeCron(entries);
}

// --- Missed cron catch-up (host crontab) ---

import { execSync } from "node:child_process";
import { CronExpressionParser } from "cron-parser";

const cronRunsPath = (): string => join(memoryDir(), "cron_runs.json");
const MANAGED_TAG = "# agentbridge-managed";

interface CronRuns { [commandHash: string]: { lastRun: number; command: string } }

function readCronRuns(): CronRuns {
  if (!existsSync(cronRunsPath())) return {};
  try { return JSON.parse(readFileSync(cronRunsPath(), "utf-8")); }
  catch { return {}; }
}

function writeCronRuns(runs: CronRuns): void {
  mkdirSync(memoryDir(), { recursive: true });
  writeFileSync(cronRunsPath(), JSON.stringify(runs, null, 2), "utf-8");
}

function hashCommand(cmd: string): string {
  // Simple stable hash from command text
  let h = 0;
  for (let i = 0; i < cmd.length; i++) h = ((h << 5) - h + cmd.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * Parse host crontab, find entries tagged `# agentbridge-managed`,
 * check if any were missed while the bridge was down, and execute them.
 *
 * @param catchUp - if true, execute missed commands. If false, just update tracking.
 *   Use catchUp=true on startup, catchUp=false on interval ticks.
 */
export function checkMissedCrons(catchUp: boolean = true): void {
  let crontab: string;
  try { crontab = execSync("crontab -l 2>/dev/null", { encoding: "utf-8" }); }
  catch { return; } // no crontab

  const lines = crontab.split("\n").filter(l => l.includes(MANAGED_TAG));
  if (lines.length === 0) return;

  const runs = readCronRuns();
  const now = Date.now();
  let changed = false;

  for (const line of lines) {
    // Extract schedule (first 5 fields) and command
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const schedule = parts.slice(0, 5).join(" ");
    const command = parts.slice(5).join(" ").replace(MANAGED_TAG, "").trim();
    const key = hashCommand(command);

    try {
      const expr = CronExpressionParser.parse(schedule);
      const prevFire = expr.prev().getTime();
      const lastRun = runs[key]?.lastRun ?? 0;

      if (prevFire > lastRun) {
        if (catchUp) {
          logInfo(TAG, `⏰ Missed cron detected — running: ${command.slice(0, 80)}...`);
          try {
            const child = spawn("bash", ["-c", command], {
              stdio: "ignore", detached: true,
            });
            child.unref();
          } catch (err) {
            logWarn(TAG, `Failed to run missed cron: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }
        runs[key] = { lastRun: now, command };
        changed = true;
      } else if (!runs[key]) {
        runs[key] = { lastRun: prevFire, command };
        changed = true;
      }
    } catch (err) {
      logWarn(TAG, `Failed to parse cron schedule "${schedule}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (changed) writeCronRuns(runs);
}

/**
 * Called by host crontab after successful execution to update lastRun.
 * Usage: node -e "import(...).then(m => m.markCronRan('command'))"
 */
export function markCronRan(command: string): void {
  const runs = readCronRuns();
  runs[hashCommand(command)] = { lastRun: Date.now(), command };
  writeCronRuns(runs);
}

// --- Browse task checker ---

import { readPendingBrowse, writePendingBrowse } from "../cli/agentbridge-browse.js";
import type { PendingBrowseEntry } from "../cli/agentbridge-browse.js";

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function readLogTail(logFile: string, maxChars: number = 2000): string {
  try {
    if (!existsSync(logFile)) return "(no log file)";
    const content = readFileSync(logFile, "utf-8");
    if (!content) return "(empty log)";

    // Extract agent response text from ACP JSON-RPC log
    const chunks: string[] = [];
    for (const line of content.split("\n")) {
      try {
        const msg = JSON.parse(line);
        if (msg.method === "session/update" && msg.params?.update?.sessionUpdate === "agent_message_chunk") {
          const text = msg.params.update.content?.text;
          if (text) chunks.push(text);
        }
      } catch { /* skip non-JSON lines */ }
    }

    if (chunks.length > 0) {
      const full = chunks.join("");
      return full.length > maxChars ? full.slice(0, maxChars) + "\n…(truncated)" : full;
    }

    // Fallback: last N chars of raw log
    const tail = content.slice(-500);
    return tail.length > maxChars ? tail.slice(0, maxChars) + "…" : tail;
  } catch { return "(failed to read log)"; }
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
      // Process finished — deliver result
      const result = readLogTail(entry.logFile);
      const taskLabel = entry.task.length > 200 ? entry.task.slice(0, 200) + "…" : entry.task;
      appendReminder({
        chatId: entry.chatId,
        message: `🌐 Browser task completed: ${taskLabel}\n\n${result}`,
        createdAt: now,
      });
      logInfo(TAG, `🌐 Browse task "${taskLabel}" finished (pid=${entry.pid})`);
    } else if (elapsed > entry.timeoutMs) {
      // Timed out — kill and report
      try { process.kill(entry.pid, "SIGKILL"); } catch { /* already dead */ }
      const taskLabel = entry.task.length > 200 ? entry.task.slice(0, 200) + "…" : entry.task;
      appendReminder({
        chatId: entry.chatId,
        message: `🌐 Browser task timed out after ${Math.round(entry.timeoutMs / 1000)}s: ${taskLabel}`,
        createdAt: now,
      });
      logWarn(TAG, `🌐 Browse task "${taskLabel}" timed out — killed pid=${entry.pid}`);
    } else {
      // Still running within timeout — keep
      remaining.push(entry);
    }
  }

  writePendingBrowse(remaining);
}
