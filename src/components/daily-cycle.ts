/**
 * Daily cycle check — shared by standby handler and age-check heartbeat task.
 *
 * After BED_TIME, counts quiet ticks (no new messages). After 6 quiet ticks
 * (~30min at 5min heartbeat), triggers sleep. Any new message resets the counter.
 */
import { readFileSync } from "node:fs";
import type { MemoryManager } from "../memory/memory-manager.js";
import { logInfo } from "./logger.js";

export interface DailyCycleDeps {
  sleepHour: number;
  sleepMinute: number;
  bridgeLockPath: string;
  memory: MemoryManager | null;
  busyChats: Set<string>;
  isSleepActive: () => boolean;
  onSleepWarning?: () => void;
}

const QUIET_TICKS_REQUIRED = parseInt(process.env["BED_QUIET_TICKS"] ?? "6", 10); // default 6 × 5min = 30min

let quietTickCount = 0;
let lastSeenMsgTs = 0;

/** Reset the quiet tick counter (call when user sends a message). */
export function resetBedtimeCounter(): void {
  quietTickCount = 0;
}

/** Returns true if conditions are met for the daily restart + sleep cycle. */
export function isDailyCycleDue(deps: DailyCycleDeps): boolean {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const sleepMinutes = deps.sleepHour * 60 + deps.sleepMinute;
  if (nowMinutes < sleepMinutes) {
    quietTickCount = 0; // not bedtime yet, reset
    return false;
  }

  try {
    const lockData = JSON.parse(readFileSync(deps.bridgeLockPath, "utf-8"));
    const todaySleepTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), deps.sleepHour, deps.sleepMinute).getTime();
    if (lockData.startedAt >= todaySleepTime) return false;
    if (!lockData.lastHeartbeat) return false; // no successful tick yet — dark wake guard
  } catch { return false; }

  if (deps.busyChats.size > 0 || deps.isSleepActive()) return false;

  // Check for new messages since last tick
  let currentMsgTs = 0;
  try {
    const row = deps.memory?.getDb()?.prepare("SELECT MAX(timestamp) as latest FROM messages WHERE content NOT LIKE '%[SYSTEM%'").get() as { latest: number | null } | undefined;
    currentMsgTs = row?.latest ?? 0;
  } catch { return false; }

  if (currentMsgTs > lastSeenMsgTs) {
    // New message arrived — reset counter
    lastSeenMsgTs = currentMsgTs;
    quietTickCount = 0;
    logInfo("bedtime", `Message received — quiet counter reset (BED_TIME ${deps.sleepHour}:${String(deps.sleepMinute).padStart(2, "0")})`);
    return false;
  }

  // No new messages this tick — increment quiet counter
  quietTickCount++;
  logInfo("bedtime", `Quiet tick ${quietTickCount}/${QUIET_TICKS_REQUIRED} (BED_TIME ${deps.sleepHour}:${String(deps.sleepMinute).padStart(2, "0")})`);

  // T-1: warn the agent one tick before sleep triggers
  if (quietTickCount === QUIET_TICKS_REQUIRED - 1 && deps.onSleepWarning) {
    deps.onSleepWarning();
  }

  return quietTickCount >= QUIET_TICKS_REQUIRED;
}
