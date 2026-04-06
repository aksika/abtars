/**
 * Browse task delivery — result extraction and notification for completed browse tasks.
 * Safety net for timeout kills and orphaned processes (normal completion via exit callback in index.ts).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../../paths.js";
import { logInfo, logWarn } from "../../components/logger.js";
import { localDate } from "../../components/env-utils.js";
import { appendReminder } from "../../components/cron/cron-checker.js";
import { readPendingBrowse, writePendingBrowse } from "./agentbridge-browse.js";
import type { PendingBrowseEntry } from "./agentbridge-browse.js";

const TAG = "browse-delivery";

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

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

const subagentsDir = (): string => join(agentBridgeHome(), "subagents");

function ensureReportFile(taskId: string): string {
  const dir = subagentsDir();
  mkdirSync(dir, { recursive: true });
  try {
    const existing = readdirSync(dir).find(f => f.startsWith(`browse_${taskId}`));
    if (existing) return join(dir, existing);
  } catch { /* */ }
  const logFile = join(agentBridgeHome(), "logs", `browse_${taskId}.log`);
  const text = extractAgentText(logFile);
  const date = localDate();
  const reportPath = join(dir, `browse_${taskId}_${date}.md`);
  writeFileSync(reportPath, text || "(no output captured)", "utf-8");
  return reportPath;
}

/** Deliver result for a single browse task. */
export function deliverBrowseResult(entry: PendingBrowseEntry, timedOut = false): void {
  const reportPath = ensureReportFile(entry.taskId);
  const taskLabel = entry.task.length > 200 ? entry.task.slice(0, 200) + "…" : entry.task;
  const msg = timedOut
    ? `🌐 Browse task timed out (${Math.round(entry.timeoutMs / 1000)}s): ${taskLabel}\nPartial report: ${reportPath}`
    : `🌐 Browse task complete: ${taskLabel}\nReport: ${reportPath}`;
  appendReminder({ chatId: entry.chatId, message: msg, createdAt: Date.now(), threadId: entry.threadId });
  (timedOut ? logWarn : logInfo)(TAG, `🌐 Browse "${taskLabel}" ${timedOut ? "timed out" : "finished"} — ${reportPath}`);
}

/** Safety net: check for completed/timed-out browse tasks. Normal completion handled by exit callback. */
export function checkBrowseTasks(): void {
  const entries = readPendingBrowse();
  if (entries.length === 0) return;

  const now = Date.now();
  const remaining: PendingBrowseEntry[] = [];

  for (const entry of entries) {
    const alive = isProcessAlive(entry.pid);
    const elapsed = now - entry.startedAt;

    if (!alive) {
      deliverBrowseResult(entry);
    } else if (elapsed > entry.timeoutMs) {
      try { process.kill(entry.pid, "SIGKILL"); } catch { /* */ }
      deliverBrowseResult(entry, true);
    } else {
      remaining.push(entry);
    }
  }

  writePendingBrowse(remaining);
}
