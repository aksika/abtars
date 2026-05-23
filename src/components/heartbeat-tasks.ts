/**
 * Heartbeat tasks extracted from bridge-app.ts — complex periodic operations
 * that benefit from being independently readable and testable.
 */

import { logAndSwallow } from "./log-and-swallow.js";
import { execSync } from "node:child_process";
import { logInfo, logError } from "./logger.js";
import { setIdleCompactReset } from "./message-pipeline.js";
import type { SessionRegistry } from "./session-registry.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import type { MemoryManager } from "abmind";
import type { HeartbeatTask } from "abmind";
import { isDailyCycleDue, type DailyCycleDeps } from "./daily-cycle.js";
export interface IdleCompactDeps {
  transport: IKiroTransport;
  memory: MemoryManager | null;
  memoryDir: string;
  allowedUserIds: Set<number>;
  sessions: SessionRegistry;
  isSleepActive: () => boolean;
}

/** Idle compaction removed — context engine handles compaction automatically via buildContext(). */
export function createIdleCompactTask(_deps: IdleCompactDeps): HeartbeatTask {
  setIdleCompactReset(() => {});
  return {
    name: "idle-compact",
    heavy: false,
    execute: async () => false,
  };
}

export type AgeCheckDeps = DailyCycleDeps & { doctorPath: string; startSleep?: () => void; checkHwSleep?: () => void; cronBusy?: () => boolean };

/** Daily cycle — spawn Dreamy after BED_TIME + quiet ticks, then hw sleep after more quiet ticks. */
export function createAgeCheckTask(deps: AgeCheckDeps): HeartbeatTask {
  return {
    name: "age-check",
    execute: async () => {
      if (deps.checkHwSleep && !deps.cronBusy?.()) deps.checkHwSleep();
      if (!isDailyCycleDue(deps)) return;
      logInfo("age-check", `😴 BED_TIME (${deps.sleepHour}:${String(deps.sleepMinute).padStart(2, "0")}) — spawning Dreamy`);
      try { execSync(`${deps.doctorPath} --fix`, { timeout: 30000 }); } catch (err) { logAndSwallow("heartbeat_tasks", "op", err); }
      if (deps.startSleep) { deps.startSleep(); }
    },
  };
}

/** DB integrity check — runs PRAGMA integrity_check every ~1 hour. */
export function createDbIntegrityTask(memory: MemoryManager | null): HeartbeatTask {
  let counter = 0;
  return {
    name: "db-integrity",
    execute: async () => {
      counter++;
      if (counter % 72 !== 0) return;
      if (!memory) return;
      const result = memory.maintenance.checkIntegrity();
      if (result !== "ok") {
        logError("db-integrity", `Memory DB integrity check failed: ${result}`);
        const { rebuilt } = memory.rebuildFtsIndexes();
        if (rebuilt.length > 0) logInfo("db-integrity", `Auto-rebuilt FTS indexes: ${rebuilt.join(", ")}`);
      }
    },
  };
}

/** #440: Check for updates on npm, notify if newer version available. */
export function createUpdateCheckTask(notify: (msg: string) => void): HeartbeatTask {
  return {
    name: "update-check",
    async execute() {
      if (process.env["UPDATES_CHECK_ENABLED"] === "false") return;
      const { checkForUpdate } = await import("./update-check.js");
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { abtarsHome } = await import("../paths.js");
      let version = "0.0.0";
      try {
        const m = JSON.parse(readFileSync(join(abtarsHome(), "manifest.json"), "utf-8"));
        version = m.version ?? "0.0.0";
      } catch { /* manifest missing */ }
      const result = checkForUpdate("abtars", version);
      if (result?.shouldNotify) {
        notify(`⚡ Update available: ${result.current} → ${result.latest}. Run: abtars update`);
      }
    },
  };
}
