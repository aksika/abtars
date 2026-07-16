import { logAndSwallow } from "../log-and-swallow.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logInfo } from "../logger.js";
import { readEntries as dbReadEntries } from "./task-store.js";
import { advanceNextRun, updateState, readState } from "./task-state-store.js";
import { todaySuccessCount } from "./task-history-store.js";
import type { ScheduledTask } from "./task-types.js";

const TAG = "cron-checker";
const memoryDir = (): string => join(abtarsHome(), "state");
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
  catch (err) { logAndSwallow(TAG, "readPendingReminders", err); return []; }
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

export function checkCron(): ScheduledTask[] {
  const entries = dbReadEntries();
  const now = Date.now();
  const dueTasks: ScheduledTask[] = [];

  for (const entry of entries) {
    if (!entry.enabled) continue;
    const state = readState(entry.id);
    if (!state) continue;
    if (state.autoPaused) continue;
    if (state.completed) continue;
    if (state.nextRunAt && state.nextRunAt > now) continue;

    if (entry.maxRunsPerDay) {
      if (todaySuccessCount(entry.id, now) >= entry.maxRunsPerDay) {
        advanceNextRun(entry.id, entry.schedule);
        continue;
      }
    }

    if (entry.schedule && state.nextRunAt) {
      const maxDelay = (entry.catchUpHours ?? 0) * 3600_000;
      const MIN_STALE_MS = 5 * 60_000;
      const staleThreshold = Math.max(maxDelay, MIN_STALE_MS);
      if (now - state.nextRunAt > staleThreshold) {
        advanceNextRun(entry.id, entry.schedule);
        logInfo(TAG, `⏭️ Stale "${entry.id}" — advanced to next occurrence`);
        continue;
      }
    }

    updateState(entry.id, { lastStartedAt: now });

    if (entry.kind === "reminder") {
      appendReminder({ chatId: parseInt(entry.chatId ?? "0", 10), message: entry.text, createdAt: now });
      advanceNextRun(entry.id, entry.schedule);
      logInfo(TAG, `⏰ Reminder fired: "${entry.text}"`);
    } else {
      dueTasks.push(entry);
    }
  }

  return dueTasks;
}
