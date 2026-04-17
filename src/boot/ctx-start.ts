/**
 * Context-window-start persistence — per-user timestamps tracking when the
 * current context window began. Used by recall fallback stages.
 *
 * Called from phase-transport (initialize at boot), phase-sleep-cycle (reset
 * after sleep), and message-pipeline (update on session turn).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Update context-window-start timestamp for a chat. */
export function updateCtxStart(memoryDir: string, userId: string, ts = Date.now()): void {
  const p = join(memoryDir, "context-window-start.json");
  let data: Record<string, number> = {};
  try { data = JSON.parse(readFileSync(p, "utf-8")); } catch { /* new file */ }
  data[userId] = ts;
  writeFileSync(p, JSON.stringify(data), "utf-8");
}

/** Set all context-window-start entries to now (called after sleep). */
export function resetAllCtxStarts(memoryDir: string): void {
  const p = join(memoryDir, "context-window-start.json");
  let data: Record<string, number> = {};
  try { data = JSON.parse(readFileSync(p, "utf-8")); } catch { return; }
  const now = Date.now();
  for (const key of Object.keys(data)) data[key] = now;
  writeFileSync(p, JSON.stringify(data), "utf-8");
}
