/**
 * Heartbeat tasks extracted from bridge-app.ts — complex periodic operations
 * that benefit from being independently readable and testable.
 */

import { execSync } from "node:child_process";
import { logInfo, logWarn, logError } from "./logger.js";
import { getEnv } from "./env-schema.js";
import { runCompaction } from "./compaction.js";
import { setIdleCompactReset } from "./message-pipeline.js";
import type { SessionRegistry } from "./session-registry.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import type { MemoryManager } from "abmind/memory-manager.js";
import type { HeartbeatTask } from "../types/memory.js";
import { isDailyCycleDue, type DailyCycleDeps } from "./daily-cycle.js";
export interface IdleCompactDeps {
  transport: IKiroTransport;
  memory: MemoryManager | null;
  memoryDir: string;
  allowedUserIds: Set<number>;
  sessions: SessionRegistry;
  isSleepActive: () => boolean;
}

/** Floating compaction — triggers when context is high and user is idle. */
export function createIdleCompactTask(deps: IdleCompactDeps): HeartbeatTask {
  const pctThreshold = getEnv().ctxIdleCompactPct;
  const idleMinutes = getEnv().ctxIdleCompactMin;
  let compactedThisIdle = false;
  setIdleCompactReset(() => { compactedThisIdle = false; });

  return {
    name: "idle-compact",
    heavy: true,
    execute: async () => {
      const pct = deps.transport.contextPercent;
      if (pct < 0 || pct < pctThreshold) return false;
      // Check if any session is busy
      const anyBusy = [...deps.sessions.keys()].some(k => deps.sessions.get(k)?.busy);
      if (compactedThisIdle || anyBusy || deps.isSleepActive()) return false;

      let lastMsgTs = 0;
      try {
        lastMsgTs = deps.memory?.getLastMessageTimestamp(true) ?? 0;
      } catch { return false; }
      if (Date.now() - lastMsgTs < idleMinutes * 60 * 1000) return false;

      const chatId = [...deps.allowedUserIds][0];
      if (!chatId) return false;
      const { loadUsers } = await import("./user-registry.js");
      const registry = loadUsers();
      const user = registry.byPlatformId.get("telegram:" + chatId);
      const sessionKey = (user?.userId ?? "master") + ":telegram";

      logInfo("idle-compact", `☕ ctx at ${pct}%, idle ${Math.round((Date.now() - lastMsgTs) / 60000)}min — compacting`);
      const entry = deps.sessions.getOrCreate(sessionKey);
      entry.busy = true;
      entry.compacting = true;
      try {
        await runCompaction(deps.transport, sessionKey, deps.sessions);
        compactedThisIdle = true;
        logInfo("idle-compact", "☕ Floating compaction complete");
      } catch (err) {
        logWarn("idle-compact", `☕ Floating compaction failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        entry.busy = false;
        entry.compacting = false;
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
