/**
 * orc-alerts.ts — #1707 Task 5: bounded operator alerting for Orc fuses.
 *
 * Trip/reset/test alerts are rate-limited per kind and can be muted for a
 * duration. Muting affects DELIVERY only — trip state stays durable in
 * orc_fuse_state and is always visible via /orc status. Alert lines carry
 * scope/counters/reason only; provider prose and secrets never cross here.
 */

import { logWarn } from "../logger.js";

const TAG = "orc-alerts";

/** Minimum interval between delivered alerts of the same kind. */
export const ORC_ALERT_MIN_INTERVAL_MS = 60_000;

const lastDeliveredAt = new Map<string, number>();
let mutedUntil = 0;

export function muteOrcAlerts(durationMs: number): number {
  const until = Date.now() + Math.max(0, durationMs);
  mutedUntil = Math.max(mutedUntil, until);
  return until;
}

export function orcAlertsMutedUntil(): number {
  return mutedUntil;
}

export function clearOrcAlertMuteForTest(): void {
  mutedUntil = 0;
  lastDeliveredAt.clear();
}

/**
 * Emit one alert line unless the kind was delivered within the interval or
 * alerts are muted. Returns true when the line was actually delivered.
 */
export function emitOrcAlert(kind: string, message: string, now = Date.now()): boolean {
  if (now < mutedUntil) return false;
  const last = lastDeliveredAt.get(kind);
  if (last !== undefined && now - last < ORC_ALERT_MIN_INTERVAL_MS) return false;
  lastDeliveredAt.set(kind, now);
  logWarn(TAG, message);
  return true;
}
