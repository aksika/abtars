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

// --- Browse task checker ---

import { readPendingBrowse, writePendingBrowse } from "../cli/agentbridge-browse.js";
import type { PendingBrowseEntry } from "../cli/agentbridge-browse.js";

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function readLogTail(logFile: string, maxChars: number = 500): string {
  try {
    if (!existsSync(logFile)) return "(no log file)";
    const content = readFileSync(logFile, "utf-8");
    return content.slice(-maxChars) || "(empty log)";
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
      appendReminder({
        chatId: entry.chatId,
        message: `🌐 Browser task completed: ${entry.task}\n\n${result}`,
        createdAt: now,
      });
      logInfo(TAG, `🌐 Browse task "${entry.task}" finished (pid=${entry.pid})`);
    } else if (elapsed > entry.timeoutMs) {
      // Timed out — kill and report
      try { process.kill(entry.pid, "SIGKILL"); } catch { /* already dead */ }
      appendReminder({
        chatId: entry.chatId,
        message: `🌐 Browser task timed out after ${Math.round(entry.timeoutMs / 1000)}s: ${entry.task}`,
        createdAt: now,
      });
      logWarn(TAG, `🌐 Browse task "${entry.task}" timed out — killed pid=${entry.pid}`);
    } else {
      // Still running within timeout — keep
      remaining.push(entry);
    }
  }

  writePendingBrowse(remaining);
}
