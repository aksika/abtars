import { getEnv } from "./env-schema.js";
/**
 * Daily cycle check — shared by standby handler and age-check heartbeat task.
 *
 * After BED_TIME, counts quiet ticks (no new messages). After 6 quiet ticks
 * (~30min at 5min heartbeat), triggers sleep. Any new message resets the counter.
 */
import type { IMemorySystem } from "abmind";
import { logInfo } from "./logger.js";
import { safeReadJson } from "./safe-json.js";
import { hasSleepAuditToday } from "abmind";
import { readBridgeLockField } from "./transport/bridge-lock-transport.js";

import type { SessionRegistry } from "./session-registry.js";

export interface DailyCycleDeps {
  sleepHour: number;
  sleepMinute: number;
  bridgeLockPath: string;
  sleepAuditDir: string;
  memory: IMemorySystem | null;
  sessions: SessionRegistry;
  isSleepActive: () => boolean;
}



let quietTickCount = 0;
let lastSeenMsgTs = 0;

/** Reset the quiet tick counter (call when user sends a message). */
export function resetBedtimeCounter(): void {
  quietTickCount = 0;
}

/** Returns true if conditions are met for the daily restart + sleep cycle. */
export function isDailyCycleDue(deps: DailyCycleDeps): boolean {
  // User-protection guards — NEVER bypass, even when forced.
  if ([...deps.sessions.keys()].some(k => deps.sessions.get(k)?.busy) || deps.isSleepActive()) return false;

  // Force-sleep request in bridge.lock — short-circuit time/audit/startedAt guards.
  // Peek-only here; spawnSleep() clears the field via readAndClearForceSleep().
  const forceSleep = readBridgeLockField<string>("forceSleep");
  if (forceSleep) {
    logInfo("bedtime", `⚡ forceSleep=${forceSleep} — bypassing bedtime/audit/startedAt guards`);
    return true;
  }

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const sleepMinutes = deps.sleepHour * 60 + deps.sleepMinute;
  if (nowMinutes < sleepMinutes) {
    quietTickCount = 0; // not bedtime yet, reset
    return false;
  }

  // Midnight wraparound: BED_TIME 0:30 means "after midnight", not "all day".
  // If more than 7 hours have passed since BED_TIME, it's daytime — not bedtime.
  if (nowMinutes - sleepMinutes > 7 * 60) {
    quietTickCount = 0;
    return false;
  }

  // Single source of truth: lock file status
  if (hasSleepAuditToday(deps.sleepAuditDir)) return false;

  const lockData = safeReadJson<{ startedAt?: number; lastHeartbeat?: number }>(deps.bridgeLockPath, {});
  if (!lockData.startedAt) return false; // fail-closed on missing/corrupt lock
  if (!lockData.lastHeartbeat) return false; // no successful tick yet — dark wake guard

  // Check for new messages since last tick
  // TODO(#510): filter to Main (A) sessions only — auto-spawn/cron shouldn't reset counter
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
  const hbSec = parseInt(process.env["HEARTBEAT_INTERVAL_SEC"] ?? "300", 10);
  const threshold = Math.ceil(getEnv().bedQuietMin * 60 / hbSec);
  logInfo("bedtime", `Quiet tick ${quietTickCount}/${threshold} (BED_TIME ${deps.sleepHour}:${String(deps.sleepMinute).padStart(2, "0")})`);

  if (quietTickCount >= threshold) {
    quietTickCount = 0; // reset after triggering — prevents re-spawn on next tick
    return true;
  }
  return false;
}
