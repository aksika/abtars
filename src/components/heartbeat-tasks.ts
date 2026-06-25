/**
 * Heartbeat tasks extracted from bridge-app.ts — complex periodic operations
 * that benefit from being independently readable and testable.
 */

import { logAndSwallow } from "./log-and-swallow.js";
import { execSync } from "node:child_process";
import { logInfo, logError } from "./logger.js";
import { setIdleCompactReset } from "./message-pipeline.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import type { MemoryManager } from "abmind";
import type { HeartbeatTask } from "../types/index.js";
import { isDailyCycleDue, type DailyCycleDeps } from "./daily-cycle.js";

const TAG = "heartbeat_tasks";
export interface IdleCompactDeps {
  transport: IKiroTransport;
  memory: MemoryManager | null;
  memoryDir: string;
  allowedUserIds: Set<number>;
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

export type AgeCheckDeps = DailyCycleDeps & { doctorPath: string; startSleep?: () => void; checkHwSleep?: () => void; checkStaleSleep?: () => void; cronBusy?: () => boolean };

/** Daily cycle — spawn Dreamy after BED_TIME + quiet ticks, then hw sleep after more quiet ticks. */
export function createAgeCheckTask(deps: AgeCheckDeps): HeartbeatTask {
  let counter = 0;
  return {
    name: "age-check",
    execute: async () => {
      counter++;
      if (counter % 5 !== 0) return; // every 5 ticks (~5 min)
      if (deps.checkStaleSleep) deps.checkStaleSleep();
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

/** #613: Flush skill usage stats to disk every 3 hours. */
export function createSkillStatsFlushTask(): HeartbeatTask {
  let lastFlushAt = 0;
  const INTERVAL_MS = 3 * 60 * 60 * 1000;
  return {
    name: "skill-stats-flush",
    execute: async () => {
      if (Date.now() - lastFlushAt < INTERVAL_MS) return;
      lastFlushAt = Date.now();
      const { flush } = await import("./skill-stats.js");
      flush();
    },
  };
}

/** #1114: Reload skills catalog every 10 minutes if skill files changed. */
export function createSkillReloadTask(): HeartbeatTask {
  let lastCheckAt = 0;
  let lastMtime = 0;
  const INTERVAL_MS = 10 * 60 * 1000;
  return {
    name: "skill-reload",
    execute: async () => {
      if (Date.now() - lastCheckAt < INTERVAL_MS) return;
      lastCheckAt = Date.now();
      const { statSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { abtarsHome } = await import("../paths.js");
      const skillsDir = join(abtarsHome(), "skills");
      try {
        const mtime = statSync(skillsDir).mtimeMs;
        if (mtime === lastMtime) return;
        lastMtime = mtime;
        const { reloadCatalog } = await import("../capabilities/hotskills/index.js");
        const count = reloadCatalog();
        logInfo("skill-reload", `Catalog regenerated: ${count} skills`);
      } catch { /* skills dir missing — skip */ }
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
  sendMessage: (chatId: string, text: string) => Promise<void>;
  sendDocument: (chatId: string, filePath: string, caption: string) => Promise<void>;
  chatId: () => string;
}

/** #857/#934: Kanban delivery — routes based on delivery_mode. */
export function createKanbanDeliveryTask(deps: KanbanDeliveryDeps): HeartbeatTask {
  return {
    name: "kanban-delivery",
    execute: async () => {
      try {
        const { kanbanPending, kanbanSetDelivering, kanbanMarkDelivered, kanbanDeliveryFailed } = await import("./tasks/kanban-board.js");
        const pending = kanbanPending();
        if (pending.length === 0) return;

        for (const card of pending) {
          if (card.delivery_mode === "silent") {
            kanbanMarkDelivered(card.id);
            continue;
          }
          kanbanSetDelivering(card.id);
          try {
            if (card.delivery_mode === "deliver") {
              if (card.result_path) await deps.sendDocument(deps.chatId(), card.result_path, card.title);
              await deps.sendSystemMessage(`[SYSTEM] Task "${card.title}" complete. File delivered: ${card.result_path ?? "(no file)"}`);
            } else {
              // "announce"
              await deps.sendSystemMessage(
                `[TASK COMPLETE] "${card.title}" done.\nResult:\n${card.result_summary ?? "(no output)"}\n\nDeliver this to the user naturally.`
              );
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
      const sessions = spin.listAllSessions();
      if (!sessions.length) return;
      const now = Date.now();
      for (const session of sessions) {
        if (session.idleTimeoutMs === Infinity) continue;
        if (session.status !== "ready") continue;
        if (!session.transport) continue;
        if (now - session.lastActiveAt > session.idleTimeoutMs) {
          spin.destroySession(session.userId, session.id);
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

/** #832: Metrics flush (every 5min) + prune (daily). */
export function createMetricsTask(cronQueueDepth: () => number): HeartbeatTask {
  let flushCounter = 0;
  let pruneCounter = 0;
  return {
    name: "metrics",
    execute: async () => {
      try {
        const { recordCronDepth, flushToFile, pruneMetricsFile } = await import("./metrics-collector.js");
        recordCronDepth(cronQueueDepth());
        flushCounter++;
        if (flushCounter % 6 === 0) flushToFile(); // ~5min (6 ticks × 50s)
        pruneCounter++;
        if (pruneCounter % 1728 === 0) pruneMetricsFile(); // ~daily (1728 ticks × 50s)
      } catch (err) { logAndSwallow(TAG, "metrics", err); }
    },
  };
}
