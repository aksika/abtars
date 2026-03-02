import { logInfo, logWarn, logDebug } from "./logger.js";
import type { HeartbeatTask } from "../types/memory.js";

export type HeartbeatConfig = {
  enabled: boolean;
  intervalMs: number;
};

const TAG = "heartbeat";

export class HeartbeatSystem {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tasks: HeartbeatTask[] = [];
  private running = false;

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

  /** Execute all registered tasks with error isolation. */
  private async tick(): Promise<void> {
    logDebug(TAG, `Tick — executing ${this.tasks.length} task(s)`);

    for (const task of this.tasks) {
      try {
        await task.execute();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn(TAG, `Task "${task.name}" failed: ${msg}`);
      }
    }
  }
}
