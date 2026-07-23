import { logInfo, logWarn, logError } from "./logger.js";
import { logAndSwallow } from "./log-and-swallow.js";
import type { HeartbeatTask, HeartbeatTaskOutcome } from "../types/index.js";
import type { AbtarsMemoryRuntime } from "./memory-runtime.js";

const TAG = "housekeeping";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type HousekeepingJob = {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
};

export type HousekeepingDeps = {
  now?: () => number;
  heartbeatIntervalMs: number;
  memoryRuntime: AbtarsMemoryRuntime | null;
  cronQueueDepth: () => number;
  notifyUpdate: (message: string) => void;
};

export function createHousekeepingTask(deps: HousekeepingDeps): HeartbeatTask {
  const nowFn = deps.now ?? Date.now;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs;

  let dbIntegrityFailures = 0;
  let dbIntegrityEscalated = false;

  const jobs: HousekeepingJob[] = [
    { name: "metrics-sample", intervalMs: heartbeatIntervalMs, run: recordCronDepth },
    { name: "metrics-flush", intervalMs: 5 * MINUTE, run: flushMetrics },
    { name: "db-integrity", intervalMs: HOUR, run: runDbIntegrity },
    { name: "skill-stats-flush", intervalMs: 3 * HOUR, run: flushSkillStats },
    { name: "update-check", intervalMs: 6 * HOUR, run: runUpdateCheck },
    { name: "metrics-prune", intervalMs: DAY, run: pruneMetrics },
    { name: "kanban-cleanup", intervalMs: DAY, run: cleanupKanban },
  ];

  const nextEligibleAt = new Float64Array(jobs.length);
  const children: string[] = [];
  const errors: string[] = [];

  return {
    name: "housekeeping",
    execute: async (): Promise<HeartbeatTaskOutcome> => {
      children.length = 0;
      errors.length = 0;

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i]!;
        const now = nowFn();
        if (now < nextEligibleAt[i]!) continue;

        nextEligibleAt[i] = now + job.intervalMs;
        children.push(job.name);
        try {
          await job.run();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logWarn(TAG, `Child "${job.name}" failed: ${msg}`);
          errors.push(`${job.name}: ${msg.slice(0, 200)}`);
        }
      }

      if (children.length === 0) {
        return { state: "idle", detail: "no work due" };
      }

      const detail = children.join(", ") + (errors.length > 0 ? `; failures: ${errors.join("; ")}` : "");
      if (errors.length > 0) {
        throw new Error(`Housekeeping failures (${children.join(", ")}): ${errors.join("; ")}`);
      }

      return { state: "ran", detail };
    },
  };

  async function recordCronDepth(): Promise<void> {
    const { recordCronDepth } = await import("./metrics-collector.js");
    recordCronDepth(deps.cronQueueDepth());
  }

  async function flushMetrics(): Promise<void> {
    const { flushToFile } = await import("./metrics-collector.js");
    flushToFile();
  }

  async function runDbIntegrity(): Promise<void> {
    if (dbIntegrityEscalated) return;
    const runtime = deps.memoryRuntime;
    if (!runtime || runtime.state !== "ready") return;
    const result = await runtime.runMaintenance({ operation: "integrity" });
    if (!result.ok) {
      logError(TAG, `Memory DB integrity check failed: ${result.summary}`);
      const rebuilt = await runtime.runMaintenance({ operation: "fts_rebuild" });
      if (rebuilt.ok) {
        logInfo(TAG, `Auto-rebuilt FTS indexes: ${rebuilt.summary}`);
        dbIntegrityFailures = 0;
      } else {
        dbIntegrityFailures++;
        if (dbIntegrityFailures >= 5) {
          dbIntegrityEscalated = true;
          const msg = "⚠️ FTS corruption persists after 5 rebuild attempts. Needs manual fix.";
          logError(TAG, msg);
          const { bufferSystemEvent } = await import("./system-event-buffer.js");
          bufferSystemEvent(msg);
        }
        throw new Error(`Integrity failed: ${result.summary}; FTS rebuild failed: ${rebuilt.summary}`);
      }
    } else {
      dbIntegrityFailures = 0;
    }
  }

  async function flushSkillStats(): Promise<void> {
    const { flush } = await import("./skill-stats.js");
    flush();
  }

  async function runUpdateCheck(): Promise<void> {
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
    if (source === "local") return;
    const result = checkForUpdate("abtars", version);
    if (result?.shouldNotify) {
      deps.notifyUpdate(`⚡ Update available: ${result.current} → ${result.latest}. Run: abtars update`);
    }
  }

  async function pruneMetrics(): Promise<void> {
    const { pruneMetricsFile } = await import("./metrics-collector.js");
    pruneMetricsFile();
  }

  async function cleanupKanban(): Promise<void> {
    const { kanbanCleanup } = await import("./tasks/kanban-board.js");
    const purged = kanbanCleanup(7);
    if (purged > 0) logInfo(TAG, `Kanban: purged ${purged} delivered cards > 7d`);
  }
}
