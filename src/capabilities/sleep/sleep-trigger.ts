import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logDebug } from "../../components/logger.js";
import { localDate } from "../../components/env-utils.js";

const TAG = "sleep-trigger";

/** Check if sleep has already run today (audit file exists with all steps ok). */
export function hasSleepAuditToday(auditDir: string): boolean {
  if (!existsSync(auditDir)) return false;
  const dateStr = localDate().replace(/-/g, "");
  try {
    const files = readdirSync(auditDir);

    // Audit .md exists → sleep completed today
    if (files.some((f) => f.startsWith(`sleep_${dateStr}`) && f.endsWith(".md"))) return true;

    const lockFile = files.find(f => f === `sleep_${dateStr}.lock`);
    if (lockFile) {
      try {
        const state = JSON.parse(readFileSync(join(auditDir, lockFile), "utf-8"));

        // Lock has a pid — check if that process is still alive
        if (state.pid) {
          try { process.kill(state.pid as number, 0); logDebug(TAG, `Sleep process ${state.pid} still running`); return true; }
          catch { /* process dead — fall through to step check */ }
        }

        const steps = Object.values(state.steps ?? {}) as Array<{ status: string }>;
        const hasFailed = steps.some(s => s.status === "failed" || s.status === "pending" || s.status === "timeout");
        if (hasFailed) {
          logDebug(TAG, "Lock file has incomplete steps — retry allowed");
          return false;
        }
        // All steps ok/skipped → sleep completed
        return steps.length > 0;
      } catch { return false; }
    }
    return false;
  } catch {
    return false;
  }
}
