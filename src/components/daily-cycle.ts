/**
 * Daily cycle check — shared by standby handler and age-check heartbeat task.
 *
 * After BED_TIME, counts quiet ticks (no new messages). After 6 quiet ticks
 * (~30min at 5min heartbeat), triggers sleep. Any new message resets the counter.
 */
import type { IMemorySystem } from "@agentbridge/memory/imemory-system.js";
import { logInfo } from "./logger.js";
import { safeReadJson } from "./safe-json.js";
import { hasSleepAuditToday } from "../capabilities/sleep/sleep-trigger.js";

export interface DailyCycleDeps {
  sleepHour: number;
  sleepMinute: number;
  bridgeLockPath: string;
  sleepAuditDir: string;
  memory: IMemorySystem | null;
  busyChats: Set<string>;
  isSleepActive: () => boolean;
}

const QUIET_TICKS_REQUIRED = parseInt(process.env["BED_QUIET_TICKS"] ?? "2", 10); // default 2 × 5min = 10min

let quietTickCount = 0;
let lastSeenMsgTs = 0;

/** Reset the quiet tick counter (call when user sends a message). */
export function resetBedtimeCounter(): void {
  quietTickCount = 0;
}

/** Get current quiet tick count (for hw sleep check). */
export function getQuietTickCount(): number {
  return quietTickCount;
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

  // Single source of truth: lock file status
  if (hasSleepAuditToday(deps.sleepAuditDir)) return false;

  const lockData = safeReadJson<{ startedAt?: number; lastHeartbeat?: number }>(deps.bridgeLockPath, {});
  const todaySleepTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), deps.sleepHour, deps.sleepMinute).getTime();
  if (!lockData.startedAt || lockData.startedAt >= todaySleepTime) return false;
  if (!lockData.lastHeartbeat) return false; // no successful tick yet — dark wake guard

  if (deps.busyChats.size > 0 || deps.isSleepActive()) return false;

  // Check for new messages since last tick
  let currentMsgTs = 0;
  try {
    const row = deps.memory?.getLastMessageTimestamp(true);
    currentMsgTs = row ?? 0;
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

  return quietTickCount >= QUIET_TICKS_REQUIRED;
}
