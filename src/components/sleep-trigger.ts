import { readdirSync, existsSync } from "node:fs";
import { logInfo, logDebug } from "./logger.js";

const TAG = "sleep-trigger";

/**
 * Simplified sleep trigger.
 * - Startup: always run
 * - Cron: ≥8am AND 10min idle AND no sleep today
 */
export class SleepTrigger {
  private spawnedToday = false;

  constructor(private auditDir: string) {}

  /** Run on startup only if ≥8am and no audit today. */
  shouldRunOnStartup(): boolean {
    if (new Date().getHours() < 8) {
      logDebug(TAG, "Startup: before 8am — skip");
      return false;
    }
    if (this.hasSleepAuditToday()) {
      logDebug(TAG, "Startup: already slept today — skip");
      return false;
    }
    logInfo(TAG, "Startup sleep triggered");
    this.spawnedToday = true;
    return true;
  }

  /**
   * Check if sleep should run from heartbeat cron.
   * Conditions: hour ≥ 8, last message > 10min ago, no audit file today, not already spawned.
   */
  shouldRunFromCron(lastMessageTs: number): boolean {
    const now = new Date();

    if (now.getHours() < 8) {
      logDebug(TAG, "Before 8am — skip");
      return false;
    }

    if (Date.now() - lastMessageTs < 10 * 60 * 1000) {
      logDebug(TAG, "User active in last 10min — skip");
      return false;
    }

    if (this.spawnedToday) {
      logDebug(TAG, "Already spawned today — skip");
      return false;
    }

    if (this.hasSleepAuditToday()) {
      logDebug(TAG, "Already slept today — skip");
      return false;
    }

    logInfo(TAG, "Cron sleep triggered (≥8am, 10min idle, no sleep today)");
    this.spawnedToday = true;
    return true;
  }

  /** Check if a sleep audit file exists for today's date. */
  private hasSleepAuditToday(): boolean {
    if (!existsSync(this.auditDir)) return false;
    const today = new Date();
    const dateStr =
      String(today.getFullYear()) +
      String(today.getMonth() + 1).padStart(2, "0") +
      String(today.getDate()).padStart(2, "0");
    try {
      return readdirSync(this.auditDir).some((f) => f.startsWith(`sleep_${dateStr}`));
    } catch {
      return false;
    }
  }
}
