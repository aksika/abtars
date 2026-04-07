/**
 * Daily cycle check — shared by standby handler and age-check heartbeat task.
 */
import { readFileSync } from "node:fs";
import type { MemoryManager } from "../memory/memory-manager.js";

export interface DailyCycleDeps {
  sleepHour: number;
  sleepMinute: number;
  bridgeLockPath: string;
  memory: MemoryManager | null;
  busyChats: Set<string>;
  isSleepActive: () => boolean;
}

/** Returns true if conditions are met for the daily restart + sleep cycle. */
export function isDailyCycleDue(deps: DailyCycleDeps): boolean {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const sleepMinutes = deps.sleepHour * 60 + deps.sleepMinute;
  if (nowMinutes < sleepMinutes) return false;

  try {
    const lockData = JSON.parse(readFileSync(deps.bridgeLockPath, "utf-8"));
    const todaySleepTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), deps.sleepHour, deps.sleepMinute).getTime();
    if (lockData.startedAt >= todaySleepTime) return false;
    if (!lockData.lastHeartbeat) return false; // no successful tick yet — dark wake guard
  } catch { return false; }

  let lastMsgTs = 0;
  try {
    const row = deps.memory?.getDb()?.prepare("SELECT MAX(timestamp) as latest FROM messages WHERE content NOT LIKE '%[SYSTEM%'").get() as { latest: number | null } | undefined;
    lastMsgTs = row?.latest ?? 0;
  } catch { return false; }
  if (Date.now() - lastMsgTs < 60 * 60 * 1000) return false;

  if (deps.busyChats.size > 0 || deps.isSleepActive()) return false;

  return true;
}
