/**
 * cron-checker — heartbeat task that fires due cron entries.
 *
 * Reminders → pending_reminders.json (picked up by main.ts message loop)
 * Tasks     → spawns kiro-cli subprocess, calls onTaskComplete callback
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../../paths.js";
import { logInfo } from "../logger.js";
import { CronExpressionParser } from "cron-parser";
import { readEntries as dbReadEntries, writeEntry, removeEntry as dbRemoveEntry } from "./cron-store.js";
import type { CronEntry } from "../../cli/agentbridge-task.js";

const TAG = "cron-checker";
const memoryDir = (): string => join(agentBridgeHome(), "memory");
const remindersPath = (): string => join(memoryDir(), "pending_reminders.json");

export interface PendingReminder {
  chatId: number;
  message: string;
  createdAt: number;
  threadId?: number;
}

export function readPendingReminders(): PendingReminder[] {
  if (!existsSync(remindersPath())) return [];
  try { return JSON.parse(readFileSync(remindersPath(), "utf-8")) as PendingReminder[]; }
  catch { return []; }
}

export function clearPendingReminders(): void {
  if (existsSync(remindersPath())) writeFileSync(remindersPath(), "[]", "utf-8");
}

export function appendReminder(r: PendingReminder): void {
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
  let entries = dbReadEntries();
  const now = Date.now();
  const dueTasks: CronEntry[] = [];

  // GC: remove fired one-shots older than 7 days
  for (const e of entries) {
    if (e.fired && !e.schedule && now - e.createdAt > GC_AGE_MS) {
      dbRemoveEntry(e.id);
      logInfo(TAG, `🗑️ GC: pruned old fired entry ${e.id}`);
    }
  }
  entries = entries.filter(e => !(e.fired && !e.schedule && now - e.createdAt > GC_AGE_MS));

  for (const entry of entries) {
    if (entry.fired || entry.paused || entry.fireAt > now) continue;

    // #327: stale detection — if past the catch-up window, advance to next occurrence
    if (entry.schedule && entry.fireAt <= now) {
      const maxDelay = (entry.catchUp ?? 0) * 3600_000;
      // Only consider stale if missed by more than one full interval (at minimum 5 min)
      const MIN_STALE_MS = 5 * 60_000;
      const staleThreshold = Math.max(maxDelay, MIN_STALE_MS);
      if (now - entry.fireAt > staleThreshold) {
        try {
          const expr = CronExpressionParser.parse(entry.schedule);
          entry.fireAt = expr.next().getTime();
          writeEntry(entry);
          logInfo(TAG, `⏭️ Stale "${entry.id}" — advanced to next occurrence`);
        } catch { /* invalid schedule, let it fire */ }
        continue;
      }
    }

    entry.lastRanAt = now;
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

    if (entry.type === "reminder") {
      appendReminder({ chatId: entry.chatId, message: entry.message, createdAt: now });
      recordRun(entry);
      logInfo(TAG, `⏰ Reminder fired: "${entry.message}" → chat ${entry.chatId}`);
    } else {
      recordRun(entry);
      dueTasks.push({ ...entry, _retrying: wasRetry || undefined });
    }

    writeEntry(entry);
  }

  return dueTasks;
}
