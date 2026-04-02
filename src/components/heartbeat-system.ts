import { logInfo, logWarn, logDebug } from "./logger.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { HeartbeatTask } from "../types/memory.js";

export type HeartbeatConfig = {
  enabled: boolean;
  intervalMs: number;
  /** When true, skip all heavy tasks (e.g. sleep in progress — avoid model rate limits). */
  sleepActive?: () => boolean;
};

const TAG = "heartbeat";
const MIN_UPTIME_MS = 1 * 60 * 1000;

export class HeartbeatSystem {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tasks: HeartbeatTask[] = [];
  private running = false;
  private readonly startedAt = Date.now();

  constructor(private config: HeartbeatConfig) {}

  /** Register a task to run on each heartbeat tick. */
  registerTask(task: HeartbeatTask): void {
    this.tasks.push(task);
  }

  /** Start the heartbeat loop. Logs interval and registered task names. */
  start(): void {
    if (this.running) return;
    if (!this.config.enabled) {
      logInfo(TAG, "Heartbeat disabled by configuration");
      return;
    }

    this.running = true;
    const taskNames = this.tasks.map((t) => t.name).join(", ");
    logInfo(TAG, `Starting heartbeat — interval=${this.config.intervalMs}ms, tasks=[${taskNames}]`);

    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.intervalMs);
  }

  /** Stop the heartbeat loop and clean up timers. */
  stop(): void {
    if (!this.running) return;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logInfo(TAG, "Heartbeat stopped");
  }

  /** Whether the heartbeat loop is running. */
  get isRunning(): boolean { return this.running; }

  /** Configured interval in milliseconds. */
  get intervalMs(): number { return this.config.intervalMs; }

  /** Get registered task names. */
  getTaskNames(): string[] {
    return this.tasks.map(t => t.name);
  }

  /** Execute all registered tasks with error isolation. Heavy-task gating: once a heavy task returns true, remaining heavy tasks are skipped. */
  private async tick(): Promise<void> {
    const uptime = Date.now() - this.startedAt;
    if (uptime < MIN_UPTIME_MS) {
      logDebug(TAG, `Skipping tick — uptime ${Math.round(uptime / 1000)}s < 3min`);
      return;
    }
    logDebug(TAG, `Tick — executing ${this.tasks.length} task(s)`);
    let heavyRan = false;
    const sleepBlocking = this.config.sleepActive?.() ?? false;

    for (const task of this.tasks) {
      try {
        if (task.heavy && (heavyRan || sleepBlocking)) {
          logDebug(TAG, `Skipping heavy task "${task.name}" — ${sleepBlocking ? "sleep in progress" : "another heavy task already ran"}`);
          continue;
        }
        const result = await task.execute();
        if (task.heavy && result === true) heavyRan = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn(TAG, `Task "${task.name}" failed: ${msg}`);
      }
    }

    // Write heartbeat timestamp — doctor checks this on startup
    try {
      writeFileSync(join(homedir(), ".agentbridge", "memory", ".heartbeat"), String(Date.now()), "utf-8");
    } catch { /* best-effort */ }
  }
}
