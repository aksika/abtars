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

const TAG = "heartbeat_tasks";
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

/** DB integrity check — runs every ~1 hour (time-based, independent of tick interval). */
export function createDbIntegrityTask(memory: MemoryManager | null): HeartbeatTask {
  let lastCheckAt = 0;
  const INTERVAL_MS = 60 * 60 * 1000;
  const MAX_FAILURES = 5;
  let consecutiveFailures = 0;
  let escalated = false;
  return {
    name: "db-integrity",
    execute: async () => {
      if (escalated) return;
      if (Date.now() - lastCheckAt < INTERVAL_MS) return;
      lastCheckAt = Date.now();
      if (!memory) return;
      const result = memory.maintenance.checkIntegrity();
      if (result !== "ok") {
        logError("db-integrity", `Memory DB integrity check failed: ${result}`);
        const { rebuilt } = memory.rebuildFtsIndexes();
        if (rebuilt.length > 0) {
          logInfo("db-integrity", `Auto-rebuilt FTS indexes: ${rebuilt.join(", ")}`);
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_FAILURES) {
            escalated = true;
            const msg = `⚠️ FTS corruption persists after ${MAX_FAILURES} rebuild attempts. Needs manual fix.`;
            logError("db-integrity", msg);
            const { bufferSystemEvent } = await import("./system-event-buffer.js");
            bufferSystemEvent(msg);
          }
        }
      } else {
        consecutiveFailures = 0;
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
      let source = "npm";
      try {
        const m = JSON.parse(readFileSync(join(abtarsHome(), "manifest.json"), "utf-8"));
        version = m.version ?? "0.0.0";
        source = m.source ?? "npm";
      } catch (err) { logAndSwallow(TAG, "read manifest.json", err); }
      if (source === "local") return; // git deploys are always ahead of npm
      const result = checkForUpdate("abtars", version);
      if (result?.shouldNotify) {
        notify(`⚡ Update available: ${result.current} → ${result.latest}. Run: abtars update`);
      }
    },
  };
}

/** #613: Flush skill usage stats to disk every heartbeat tick. */
export function createSkillStatsFlushTask(): HeartbeatTask {
  return {
    name: "skill-stats-flush",
    execute: async () => {
      const { flush } = await import("./skill-stats.js");
      flush();
    },
  };
}

/** #613: Prune .trash/ entries older than 7 days. */
export function createSkillTrashPruneTask(): HeartbeatTask {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  let counter = 0;
  return {
    name: "skill-trash-prune",
    execute: async () => {
      counter++;
      if (counter % 72 !== 0) return; // ~hourly (72 ticks × 50s)
      const { existsSync, readdirSync, rmSync, statSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { abtarsHome } = await import("../paths.js");
      const trashPath = join(abtarsHome(), "skills", ".trash");
      if (!existsSync(trashPath)) return;
      const now = Date.now();
      for (const entry of readdirSync(trashPath)) {
        try {
          const full = join(trashPath, entry);
          const stat = statSync(full);
          if (now - stat.mtimeMs > SEVEN_DAYS_MS) {
            rmSync(full, { recursive: true });
            logInfo("skill-trash-prune", `Pruned: ${entry}`);
          }
        } catch (err) { logAndSwallow(TAG, "prune entry", err); }
      }
    },
  };
}

/** #681: Rotate audit.jsonl when > 10MB, prune files older than 30 days. */
export function createAuditRotationTask(): HeartbeatTask {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  let counter = 0;
  return {
    name: "audit-rotation",
    execute: async () => {
      counter++;
      if (counter % 72 !== 0) return; // ~hourly
      const { existsSync, statSync, renameSync, readdirSync, unlinkSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { abtarsHome } = await import("../paths.js");
      const logsDir = join(abtarsHome(), "logs");
      const auditPath = join(logsDir, "audit.jsonl");
      if (!existsSync(auditPath)) return;
      try {
        const stat = statSync(auditPath);
        if (stat.size > 10 * 1024 * 1024) {
          const date = new Date().toISOString().slice(0, 10);
          renameSync(auditPath, join(logsDir, `audit-${date}.jsonl`));
          logInfo("audit-rotation", `Rotated audit.jsonl (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
        }
      } catch (err) { logAndSwallow(TAG, "audit rotate", err); }
      // Prune old audit files
      const now = Date.now();
      try {
        for (const f of readdirSync(logsDir)) {
          if (!f.startsWith("audit-") || !f.endsWith(".jsonl")) continue;
          const full = join(logsDir, f);
          const stat = statSync(full);
          if (now - stat.mtimeMs > THIRTY_DAYS_MS) {
            unlinkSync(full);
            logInfo("audit-rotation", `Pruned: ${f}`);
          }
        }
      } catch (err) { logAndSwallow(TAG, "audit prune", err); }
    },
  };
}

export interface KanbanDeliveryDeps {
  sendSystemMessage: (prompt: string) => Promise<void>;
  sendDocument: (chatId: string, filePath: string, caption: string) => Promise<void>;
  chatId: () => string;
}

/** #857: Kanban delivery — picks up completed cards and delivers via agent pipeline. */
export function createKanbanDeliveryTask(deps: KanbanDeliveryDeps): HeartbeatTask {
  return {
    name: "kanban-delivery",
    execute: async () => {
      try {
        const { kanbanPending, kanbanSetDelivering, kanbanMarkDelivered, kanbanDeliveryFailed } = await import("./tasks/kanban-board.js");
        const pending = kanbanPending();
        if (pending.length === 0) return;

        for (const card of pending) {
          kanbanSetDelivering(card.id);
          try {
            await deps.sendSystemMessage(
              `[SYSTEM] [TASK COMPLETE] Your task "${card.title}" is done. ` +
              `Announce completion briefly and tell the user to see the attached file. ` +
              `Do not reproduce the full content.\n\nSummary for your memory: ${card.result_summary ?? "(no summary)"}`
            );
            if (card.result_path) {
              await deps.sendDocument(deps.chatId(), card.result_path, `📄 ${card.title}`);
            }
            kanbanMarkDelivered(card.id);
          } catch (err) {
            kanbanDeliveryFailed(card.id);
            logError(TAG, `Kanban delivery failed for card ${card.id}: ${err}`);
          }
        }
      } catch (err) { logAndSwallow(TAG, "kanban-delivery", err); }
    },
  };
}

/** #936: Expire idle user sessions managed by Spin. */
export function createUserSessionExpiryTask(): HeartbeatTask {
  return {
    name: "user-session-expiry",
    execute: async () => {
      const { spin } = await import("./spin.js");
      const now = Date.now();
      for (const session of spin.userSessions.values()) {
        if (session.idleTimeoutMs === Infinity) continue;
        if (session.state !== "ready") continue;
        if (now - session.lastActiveAt > session.idleTimeoutMs) {
          spin.destroySession(session.userId);
        }
      }
    },
  };
}

/** #857: Kanban cleanup — purge delivered cards older than 7 days. */
export function createKanbanCleanupTask(): HeartbeatTask {
  let counter = 0;
  return {
    name: "kanban-cleanup",
    execute: async () => {
      counter++;
      if (counter % 72 !== 0) return; // ~hourly
      try {
        const { kanbanCleanup } = await import("./tasks/kanban-board.js");
        const purged = kanbanCleanup(7);
        if (purged > 0) logInfo(TAG, `Kanban: purged ${purged} delivered cards > 7d`);
      } catch (err) { logAndSwallow(TAG, "kanban-cleanup", err); }
    },
  };
}
