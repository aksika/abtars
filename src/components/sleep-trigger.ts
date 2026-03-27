import { readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logInfo, logDebug } from "./logger.js";
import { localDate } from "./env-utils.js";

const TAG = "sleep-trigger";
const MAX_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 60 * 60 * 1000; // 1h cooldown after 2nd failure

/**
 * Sleep trigger with retry support.
 * - Startup: run if no audit today (or >25h since last)
 * - Cron: ≥8am AND 10min idle AND not exhausted
 * - On failure: retry on next HB (attempt 2), then after 1h cooldown (attempt 3)
 * - On success or 3 failures: stop until next 24h cycle
 */
export class SleepTrigger {
  private attempts = 0;
  private lastFailureTime = 0;

  constructor(private auditDir: string) {}

  /** Report that sleep completed successfully. Stops further retries. */
  reportSuccess(): void {
    logInfo(TAG, `Sleep succeeded (attempt ${this.attempts})`);
    this.attempts = MAX_ATTEMPTS; // block further attempts
  }

  /** Report that sleep failed. Enables retry on next eligible HB. */
  reportFailure(): void {
    this.lastFailureTime = Date.now();
    logInfo(TAG, `Sleep failed (attempt ${this.attempts}/${MAX_ATTEMPTS}, next retry ${this.attempts < MAX_ATTEMPTS ? (this.attempts === 1 ? "on next HB" : "after 1h cooldown") : "none — exhausted"})`);
  }

  shouldRunOnStartup(): boolean {
    if (this.hasSleepAuditToday()) {
      logDebug(TAG, "Startup: already slept today — skip");
      return false;
    }
    const lastAuditAge = this.getLastAuditAgeMs();
    if (lastAuditAge > 25 * 60 * 60 * 1000) {
      logInfo(TAG, `Startup sleep triggered (last audit ${Math.round(lastAuditAge / 3600000)}h ago, >25h threshold)`);
      this.attempts = 1;
      return true;
    }
    if (new Date().getHours() < 8) {
      logDebug(TAG, "Startup: before 8am — skip");
      return false;
    }
    logInfo(TAG, "Startup sleep triggered");
    this.attempts = 1;
    return true;
  }

  /**
   * Check if sleep should run from heartbeat cron.
   * Attempt 1: normal trigger (≥8am, 10min idle, no audit today)
   * Attempt 2: next HB after failure (same conditions minus spawnedToday guard)
   * Attempt 3: only after 1h cooldown from last failure
   */
  shouldRunFromCron(lastMessageTs: number): boolean {
    if (new Date().getHours() < 8) return false;
    if (Date.now() - lastMessageTs < 10 * 60 * 1000) return false;

    // Already succeeded or exhausted retries
    if (this.attempts >= MAX_ATTEMPTS) {
      logDebug(TAG, "Exhausted retries — skip until next day");
      return false;
    }

    // Already have a successful audit today (e.g. from a previous process run)
    if (this.hasSleepAuditToday()) {
      logDebug(TAG, "Already slept today — skip");
      return false;
    }

    // First attempt — normal trigger
    if (this.attempts === 0) {
      logInfo(TAG, "Cron sleep triggered (≥8am, 10min idle, no sleep today)");
      this.attempts = 1;
      return true;
    }

    // Attempt 2: immediate retry on next HB
    if (this.attempts === 1) {
      logInfo(TAG, "Cron sleep retry 1 (next HB after failure)");
      this.attempts = 2;
      return true;
    }

    // Attempt 3: only after 1h cooldown
    if (this.attempts === 2 && Date.now() - this.lastFailureTime >= RETRY_COOLDOWN_MS) {
      logInfo(TAG, "Cron sleep retry 2 (1h cooldown elapsed)");
      this.attempts = 3;
      return true;
    }

    return false;
  }

  /** Write a lock file immediately so restarts don't spawn duplicates. */
  writeLock(): void {
    try {
      mkdirSync(this.auditDir, { recursive: true });
      const today = localDate().replace(/-/g, "");
      writeFileSync(join(this.auditDir, `sleep_${today}.lock`), String(process.pid), "utf-8");
      logInfo(TAG, "Lock file written");
    } catch { /* best-effort */ }
  }

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

  getLastAuditAgeMs(): number {
    if (!existsSync(this.auditDir)) return Infinity;
    try {
      const files = readdirSync(this.auditDir).filter(f => f.startsWith("sleep_")).sort();
      if (files.length === 0) return Infinity;
      const last = files[files.length - 1]!;
      const m = last.match(/^sleep_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
      if (!m) return Infinity;
      const ts = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`).getTime();
      return Date.now() - ts;
    } catch {
      return Infinity;
    }
  }
}
