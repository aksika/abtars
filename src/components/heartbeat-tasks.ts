/**
 * Heartbeat tasks extracted from bridge-app.ts — complex periodic operations
 * that benefit from being independently readable and testable.
 */

import { execSync } from "node:child_process";
import { logInfo, logWarn, logError } from "./logger.js";
import { runCompaction } from "./compaction.js";
import { compactingSessions, setIdleCompactReset } from "./message-pipeline.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import type { MemoryManager } from "abmind/memory-manager.js";
import type { HeartbeatTask } from "../types/memory.js";
import { isDailyCycleDue, type DailyCycleDeps } from "./daily-cycle.js";
export interface IdleCompactDeps {
  transport: IKiroTransport;
  memory: MemoryManager | null;
  memoryDir: string;
  allowedUserIds: Set<number>;
  busyChats: Set<string>;
  pendingSessionStart: Set<string>;
  isSleepActive: () => boolean;
}

/** Floating compaction — triggers when context is high and user is idle. */
export function createIdleCompactTask(deps: IdleCompactDeps): HeartbeatTask {
  const pctThreshold = parseInt(process.env["CTX_IDLE_COMPACT_PCT"] ?? "65", 10);
  const idleMinutes = parseInt(process.env["CTX_IDLE_COMPACT_MIN"] ?? "10", 10);
  let compactedThisIdle = false;
  setIdleCompactReset(() => { compactedThisIdle = false; });

  return {
    name: "idle-compact",
    heavy: true,
    execute: async () => {
      const pct = deps.transport.contextPercent;
      if (pct < 0 || pct < pctThreshold) return false;
      if (compactedThisIdle || deps.busyChats.size > 0 || deps.isSleepActive()) return false;

      let lastMsgTs = 0;
      try {
        lastMsgTs = deps.memory?.getLastMessageTimestamp(true) ?? 0;
      } catch { return false; }
      if (Date.now() - lastMsgTs < idleMinutes * 60 * 1000) return false;

      const chatId = [...deps.allowedUserIds][0];
      if (!chatId) return false;
      // Resolve userId session key from registry
      const { loadUsers } = await import("./user-registry.js");
      const registry = loadUsers();
      const user = registry.byPlatformId.get("telegram:" + chatId);
      const sessionKey = (user?.userId ?? "master") + ":telegram";

      logInfo("idle-compact", `☕ ctx at ${pct}%, idle ${Math.round((Date.now() - lastMsgTs) / 60000)}min — compacting`);
      deps.busyChats.add(sessionKey);
      compactingSessions.add(sessionKey);
      try {
        await runCompaction(deps.transport, sessionKey, deps.pendingSessionStart);
        compactedThisIdle = true;
        logInfo("idle-compact", "☕ Floating compaction complete");
      } catch (err) {
        logWarn("idle-compact", `☕ Floating compaction failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        deps.busyChats.delete(sessionKey);
        compactingSessions.delete(sessionKey);
      }
      return true;
    },
  };
}

export type AgeCheckDeps = DailyCycleDeps & { doctorPath: string; startSleep?: () => void; checkHwSleep?: () => void; cronBusy?: () => boolean };

/** Daily cycle — spawn Dreamy after BED_TIME + quiet ticks, then hw sleep after more quiet ticks. */
export function createAgeCheckTask(deps: AgeCheckDeps): HeartbeatTask {
  return {
    name: "age-check",
    execute: async () => {
      // Check hw sleep (post-Dreamy quiet ticks) — skip if cron job running.
      // checkHwSleep owns its own counter state internally; no longer driven by daily-cycle's quietTickCount.
      if (deps.checkHwSleep && !deps.cronBusy?.()) deps.checkHwSleep();

      if (!isDailyCycleDue(deps)) return;

      logInfo("age-check", `😴 BED_TIME (${deps.sleepHour}:${String(deps.sleepMinute).padStart(2, "0")}) — spawning Dreamy`);
      try { execSync(`${deps.doctorPath} --fix`, { timeout: 30000 }); } catch { /* */ }
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
      if (counter % 72 !== 0) return; // every 72 ticks = ~6 hours
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
