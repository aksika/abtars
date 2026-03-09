import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { logInfo, logWarn, logDebug } from "./logger.js";

const TAG = "sleep-trigger";

export interface SleepTriggerConfig {
  sleepIntervalHours: number; // default 24
  morningThresholdHour: number; // default 9 (9am local)
  inactivityMinutes: number; // default 30
}

/**
 * Load SleepTriggerConfig from environment variables with fallback defaults.
 */
export function loadSleepTriggerConfig(): SleepTriggerConfig {
  const parseNum = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      logWarn(TAG, `${key} must be a valid number, got "${raw}" — using default ${fallback}`);
      return fallback;
    }
    return n;
  };

  return {
    sleepIntervalHours: parseNum("MEMORY_SLEEP_INTERVAL_HOURS", 24),
    morningThresholdHour: parseNum("MEMORY_SLEEP_MORNING_HOUR", 9),
    inactivityMinutes: parseNum("MEMORY_SLEEP_INACTIVITY_MINUTES", 30),
  };
}

export class SleepTrigger {
  constructor(
    private config: SleepTriggerConfig,
    private auditDir: string,
    private workingDir: string,
  ) {}

  /**
   * Check if sleep should run on startup.
   *
   * Returns true if:
   * - No audit file exists, OR
   * - Most recent audit is older than intervalHours, OR
   * - (new calendar day AND current hour >= morningHour AND yesterday's working dir exists)
   */
  shouldRunOnStartup(): boolean {
    const lastSleep = this.getLastSleepTimestamp();

    if (lastSleep === null) {
      logInfo(TAG, "No previous sleep audit found — startup sleep needed");
      return true;
    }

    const now = Date.now();
    const intervalMs = this.config.sleepIntervalHours * 60 * 60 * 1000;

    if (now - lastSleep > intervalMs) {
      logInfo(TAG, "Last sleep audit is older than interval — startup sleep needed");
      return true;
    }

    // Check new calendar day + past morning hour + yesterday unconsolidated
    const lastSleepDate = new Date(lastSleep);
    const today = new Date();

    const isNewDay =
      today.getFullYear() !== lastSleepDate.getFullYear() ||
      today.getMonth() !== lastSleepDate.getMonth() ||
      today.getDate() !== lastSleepDate.getDate();

    if (isNewDay && today.getHours() >= this.config.morningThresholdHour && this.hasUnconsolidatedYesterday()) {
      logInfo(TAG, "New day, past morning hour, yesterday unconsolidated — startup sleep needed");
      return true;
    }

    logDebug(TAG, "No startup sleep needed");
    return false;
  }

  /**
   * Check if sleep should run from internal cron (called hourly).
   *
   * Returns true if:
   * - intervalHours since last sleep AND
   * - (Date.now() - lastMessageTimestamp) >= inactivityMinutes * 60 * 1000
   */
  shouldRunFromCron(lastMessageTimestamp: number): boolean {
    const lastSleep = this.getLastSleepTimestamp();
    const now = Date.now();
    const intervalMs = this.config.sleepIntervalHours * 60 * 60 * 1000;

    // If no sleep has ever run, interval condition is met
    const intervalElapsed = lastSleep === null || now - lastSleep >= intervalMs;

    if (!intervalElapsed) {
      logDebug(TAG, "Sleep interval not yet elapsed — cron skip");
      return false;
    }

    const inactivityMs = this.config.inactivityMinutes * 60 * 1000;
    const userInactive = now - lastMessageTimestamp >= inactivityMs;

    if (!userInactive) {
      logDebug(TAG, "User still active — cron skip");
      return false;
    }

    logInfo(TAG, "Interval elapsed and user inactive — cron sleep needed");
    return true;
  }

  /**
   * Get timestamp of last successful sleep run from audit dir.
   * Parses the most recent `sleep_YYYYMMDD_HHmmss.md` filename.
   * Returns null if no audit files exist or audit dir is missing.
   */
  getLastSleepTimestamp(): number | null {
    if (!existsSync(this.auditDir)) {
      logDebug(TAG, `Audit directory does not exist: ${this.auditDir}`);
      return null;
    }

    let entries: string[];
    try {
      entries = readdirSync(this.auditDir);
    } catch (err) {
      logWarn(TAG, `Failed to read audit directory: ${err}`);
      return null;
    }

    const pattern = /^sleep_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.md$/;
    let latestTs: number | null = null;

    for (const entry of entries) {
      const match = pattern.exec(entry);
      if (!match) continue;

      const [, year, month, day, hour, minute, second] = match;
      const date = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      );
      const ts = date.getTime();

      if (!Number.isNaN(ts) && (latestTs === null || ts > latestTs)) {
        latestTs = ts;
      }
    }

    return latestTs;
  }

  /**
   * Check if yesterday's working dir exists (unconsolidated).
   */
  hasUnconsolidatedYesterday(): boolean {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yyyy = yesterday.getFullYear();
    const mm = String(yesterday.getMonth() + 1).padStart(2, "0");
    const dd = String(yesterday.getDate()).padStart(2, "0");
    const yesterdayDir = join(this.workingDir, `${yyyy}-${mm}-${dd}`);

    const exists = existsSync(yesterdayDir);
    logDebug(TAG, `Yesterday's working dir ${yesterdayDir}: ${exists ? "exists" : "not found"}`);
    return exists;
  }
}
