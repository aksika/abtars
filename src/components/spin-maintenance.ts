/**
 * spin-maintenance.ts — #1540: periodic housekeeping owner for the Spin
 * facade. Owns the housekeeping cadence counter, skill-trash pruning,
 * audit-log rotation/pruning, and ended-session-prune orchestration. `Spin`
 * remains the heartbeat-facing facade; it delegates the periodic cleanup here
 * at the existing cadence. Failures retain the best-effort logging behavior —
 * they never stop the heartbeat.
 */

import { logInfo } from "./logger.js";
import { logAndSwallow } from "./log-and-swallow.js";
import type { SpinSessionRegistry } from "./spin-sessions.js";

const TAG = "spin-maintenance";
const HOUSEKEEP_EVERY = 72;
const ONE_HOUR_MS = 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface SpinMaintenance {
  /** Advance the cadence counter; run periodic cleanup every 72 calls. */
  tick(): void;
}

export interface SpinMaintenanceOptions {
  sessions: SpinSessionRegistry;
  /** Injectable clock for deterministic focused tests. */
  now?: () => number;
}

export function createSpinMaintenance(options: SpinMaintenanceOptions): SpinMaintenance {
  const now = options.now ?? (() => Date.now());
  let housekeepCounter = 0;

  /** #613: Prune .trash/ entries older than 7 days (~hourly). */
  function pruneSkillTrash(): void {
    const { existsSync, readdirSync, rmSync, statSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const { abtarsHome } = require("../paths.js") as typeof import("../paths.js");
    const trashPath = join(abtarsHome(), "skills", ".trash");
    if (!existsSync(trashPath)) return;
    const current = now();
    for (const entry of readdirSync(trashPath)) {
      try {
        const full = join(trashPath, entry);
        const stat = statSync(full);
        if (current - stat.mtimeMs > SEVEN_DAYS_MS) {
          rmSync(full, { recursive: true });
          logInfo("skill-trash-prune", `Pruned: ${entry}`);
        }
      } catch (err) { logAndSwallow(TAG, "prune entry", err); }
    }
  }

  /** #681: Rotate audit.jsonl when > 10MB, prune files older than 30 days (~hourly). */
  function rotateAuditLog(): void {
    const { existsSync, statSync, renameSync, readdirSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const { abtarsHome } = require("../paths.js") as typeof import("../paths.js");
    const logsDir = join(abtarsHome(), "logs");
    const auditPath = join(logsDir, "audit.jsonl");
    if (!existsSync(auditPath)) return;
    try {
      const stat = statSync(auditPath);
      if (stat.size > 10 * 1024 * 1024) {
        const date = new Date(now()).toISOString().slice(0, 10);
        renameSync(auditPath, join(logsDir, `audit-${date}.jsonl`));
        logInfo("audit-rotation", `Rotated audit.jsonl (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
      }
    } catch (err) { logAndSwallow(TAG, "audit rotate", err); }
    const current = now();
    try {
      for (const f of readdirSync(logsDir)) {
        if (!f.startsWith("audit-") || !f.endsWith(".jsonl")) continue;
        const full = join(logsDir, f);
        const stat = statSync(full);
        if (current - stat.mtimeMs > THIRTY_DAYS_MS) {
          unlinkSync(full);
          logInfo("audit-rotation", `Pruned: ${f}`);
        }
      }
    } catch (err) { logAndSwallow(TAG, "audit prune", err); }
  }

  return {
    tick() {
      housekeepCounter++;
      if (housekeepCounter % HOUSEKEEP_EVERY === 0) {
        pruneSkillTrash();
        rotateAuditLog();
        options.sessions.pruneEnded(now(), ONE_HOUR_MS);
      }
    },
  };
}
