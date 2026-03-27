/**
 * cron-checker — heartbeat task that fires due cron entries.
 *
 * Reminders → pending_reminders.json (picked up by main.ts message loop)
 * Tasks     → spawns kiro-cli subprocess, calls onTaskComplete callback
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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


/**
 * Scan cron.json for due entries. Fires reminders directly.
 * Returns due task entries (script + agent) for the CronQueue to process.
 * Advances fireAt and writes cron.json.
 */
export function checkCron(): CronEntry[] {
  let entries = readCron();
  const now = Date.now();
  let changed = false;
  const dueTasks: CronEntry[] = [];

  // GC: remove fired one-shots older than 7 days
  const before = entries.length;
  entries = entries.filter(e => !(e.fired && !e.schedule && now - e.createdAt > GC_AGE_MS));
  if (entries.length < before) {
    changed = true;
    logInfo(TAG, `🗑️ GC: pruned ${before - entries.length} old fired entries`);
  }

  // Sort: high → medium → low
  const prioRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  entries.sort((a, b) => {
    const pa = prioRank[a.priority ?? "medium"] ?? 1;
    const pb = prioRank[b.priority ?? "medium"] ?? 1;
    if (pa !== pb) return pa - pb;
    return (b.fireAt ?? 0) - (a.fireAt ?? 0);
  });

  for (const entry of entries) {
    if (entry.fired || entry.paused || entry.fireAt > now) continue;

    // Advance fireAt
    entry.lastRanAt = now;
    entry._prevFireAt = entry.fireAt;
    // Advance fireAt to next schedule
    const wasRetry = !!entry._retrying;
    if (entry.schedule) {
      try {
        const expr = CronExpressionParser.parse(entry.schedule);
        entry.fireAt = expr.next().getTime();
      } catch { entry.fired = true; }
    } else {
      entry.fired = true;
    }
    delete entry._retrying;
    changed = true;

    if (entry.type === "reminder") {
      appendReminder({ chatId: entry.chatId, message: entry.message, createdAt: now });
      recordRun(entry);
      logInfo(TAG, `⏰ Reminder fired: "${entry.message}" → chat ${entry.chatId}`);
    } else {
      recordRun(entry);
      dueTasks.push({ ...entry, _retrying: wasRetry || undefined });
    }
  }

  if (changed) writeCron(entries);
  return dueTasks;
}

// --- Browse task checker ---

import { readPendingBrowse, writePendingBrowse } from "../cli/agentbridge-browse.js";
import type { PendingBrowseEntry } from "../cli/agentbridge-browse.js";
import { localDate } from "./env-utils.js";

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
  const date = localDate();
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
