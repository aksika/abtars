/**
 * Heartbeat tasks extracted from bridge-app.ts — complex periodic operations
 * that benefit from being independently readable and testable.
 */

import { unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { logInfo, logWarn, logError } from "./logger.js";
import { writeRestartReason } from "./restart-reason.js";
import { runCompaction } from "./compaction.js";
import { compactingSessions, setIdleCompactReset } from "./message-pipeline.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import type { MemoryManager } from "../memory/memory-manager.js";
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
      const sessionKey = `telegram:${chatId}`;

      logInfo("idle-compact", `☕ ctx at ${pct}%, idle ${Math.round((Date.now() - lastMsgTs) / 60000)}min — compacting`);
      deps.busyChats.add(sessionKey);
      compactingSessions.add(sessionKey);
      try {
        await runCompaction(deps.transport, sessionKey, deps.memory, deps.memoryDir);
        deps.pendingSessionStart.add(sessionKey);
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

export type AgeCheckDeps = DailyCycleDeps & { doctorPath: string };

/** Daily cycle — restart bridge after SLEEP_TIME if started before it. */
export function createAgeCheckTask(deps: AgeCheckDeps): HeartbeatTask {
  return {
    name: "age-check",
    execute: async () => {
      if (!isDailyCycleDue(deps)) return;

      logInfo("age-check", `🔄 Past SLEEP_TIME (${deps.sleepHour}:00) — daily restart`);
      writeRestartReason(`daily-cycle: SLEEP_TIME ${deps.sleepHour}:00`);
      try { execSync(`${deps.doctorPath} --fix`, { timeout: 30000 }); } catch { /* */ }
      try { unlinkSync(deps.bridgeLockPath); } catch { /* */ }
      process.exit(0);
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
      if (counter % 12 !== 0) return;
      if (!memory) return;
      const result = memory.maintenance.checkIntegrity();
      if (result !== "ok") {
        logError("db-integrity", `Memory DB integrity check failed: ${result}`);
      }
    },
  };
}
