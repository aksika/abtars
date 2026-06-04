/**
 * Browse task delivery — write report + notify user via reminder.
 * Called from runtime.spawn() onComplete/onError callbacks.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logInfo, logWarn } from "../../components/logger.js";
import { localDate } from "../../utils/date.js";
import { appendReminder } from "../../components/tasks/task-checker.js";
import { readPendingBrowse, writePendingBrowse } from "./abtars-browse.js";
import type { PendingBrowseEntry } from "./abtars-browse.js";

const TAG = "browse-delivery";

const subagentsDir = (): string => join(abtarsHome(), "subagents");

/** Deliver result for a browse task. Called by runtime.spawn() callback. */
export function deliverBrowseResult(entry: PendingBrowseEntry, result: string): void {
  const dir = subagentsDir();
  mkdirSync(dir, { recursive: true });
  const date = localDate();
  const reportPath = join(dir, `browse_${entry.taskId}_${date}.md`);
  writeFileSync(reportPath, result || "(no output captured)", "utf-8");

  const taskLabel = entry.task.length > 200 ? entry.task.slice(0, 200) + "…" : entry.task;
  const msg = `🌐 Browse task complete: ${taskLabel}\nReport: ${reportPath}`;
  appendReminder({ chatId: entry.chatId, message: msg, createdAt: Date.now(), threadId: entry.threadId });
  logInfo(TAG, `🌐 Browse "${taskLabel}" finished — ${reportPath}`);
}

/** Safety net: check for stale pending entries (runtime handles timeouts, this catches orphans). */
export function checkBrowseTasks(): void {
  const entries = readPendingBrowse();
  if (entries.length === 0) return;

  const now = Date.now();
  const remaining: PendingBrowseEntry[] = [];

  for (const entry of entries) {
    const elapsed = now - entry.startedAt;
    if (elapsed > entry.timeoutMs + 60_000) {
      // Stale entry — runtime should have cleaned up, remove orphan
      const taskLabel = entry.task.length > 200 ? entry.task.slice(0, 200) + "…" : entry.task;
      logWarn(TAG, `Removing stale browse entry: ${taskLabel} (${Math.round(elapsed / 1000)}s old)`);
    } else {
      remaining.push(entry);
    }
  }

  if (remaining.length !== entries.length) writePendingBrowse(remaining);
}
