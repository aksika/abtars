import { logInfo, logWarn, logDebug } from "./logger.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../paths.js";
import type { HeartbeatTask } from "../types/memory.js";

export type HeartbeatConfig = {
  enabled: boolean;
  intervalMs: number;
  /** When true, skip all heavy tasks (e.g. sleep in progress — avoid model rate limits). */
  sleepActive?: () => boolean;
  /** Called when standby resume detected (gap > interval×3). Bridge should doctor + exit. */
  onStandbyResume?: (gapMs: number) => void;
};

const TAG = "heartbeat";
const MIN_GUARD_MS = 3 * 60 * 1000; // 3 min minimum delay before first tick

export type TaskStatus = "✓" | "✗" | "—" | "?";

export class HeartbeatSystem {
  private timer: ReturnType<typeof setInterval> | null = null;
  private initTimeout: ReturnType<typeof setTimeout> | null = null;
  private tasks: HeartbeatTask[] = [];
  private running = false;
  private lastTickAt = 0;
  private readonly taskStatuses = new Map<string, TaskStatus>();

  constructor(private config: HeartbeatConfig) {}

  /** Register a task to run on each heartbeat tick. */
  registerTask(task: HeartbeatTask): void {
    this.tasks.push(task);
  }

  /** Start the heartbeat loop, aligned to wall-clock boundaries. */
  start(): void {
    if (this.running) return;
    if (!this.config.enabled) {
      logInfo(TAG, "Heartbeat disabled by configuration");
      return;
    }

    this.running = true;
    const taskNames = this.tasks.map((t) => t.name).join(", ");
    const iv = this.config.intervalMs;

    // Align to next clock boundary (ceil(now / interval) * interval)
    const now = Date.now();
    let nextBoundary = Math.ceil(now / iv) * iv;
    let delay = nextBoundary - now;
    if (delay < MIN_GUARD_MS) {
      nextBoundary += iv;
      delay += iv;
    }

    const firstTickAt = new Date(nextBoundary).toTimeString().slice(0, 8);
    logInfo(TAG, `Starting heartbeat — interval=${iv}ms, first tick at ${firstTickAt} (${Math.round(delay / 1000)}s), tasks=[${taskNames}]`);

    this.lastTickAt = now; // seed for standby detection
    this.initTimeout = setTimeout(() => {
      this.lastTickAt = Date.now();
      void this.tick();
      this.timer = setInterval(() => {
        void this.tick();
      }, iv);
    }, delay);
  }

  /** Stop the heartbeat loop and clean up timers. */
  stop(): void {
    if (!this.running) return;
    if (this.initTimeout !== null) { clearTimeout(this.initTimeout); this.initTimeout = null; }
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
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

  /** Get last-run status for each task. */
  getTaskStatuses(): ReadonlyMap<string, TaskStatus> {
    return this.taskStatuses;
  }

  /** Execute all registered tasks with error isolation. */
  private async tick(): Promise<void> {
    const now = Date.now();
    const gap = now - this.lastTickAt;
    this.lastTickAt = now;

    // Standby detection: gap > interval × 3 means process was suspended
    if (gap > this.config.intervalMs * 3) {
      const gapMin = Math.round(gap / 60000);
      logInfo(TAG, `Standby resume detected — suspended ${gapMin}min`);
      if (this.config.onStandbyResume) {
        this.config.onStandbyResume(gap);
        return; // skip all tasks this tick
      }
    }

    logDebug(TAG, `Tick — executing ${this.tasks.length} task(s)`);
    let heavyRan = false;
    const sleepBlocking = this.config.sleepActive?.() ?? false;

    for (const task of this.tasks) {
      try {
        if (task.heavy && (heavyRan || sleepBlocking)) {
          logDebug(TAG, `Skipping heavy task "${task.name}" — ${sleepBlocking ? "sleep in progress" : "another heavy task already ran"}`);
          this.taskStatuses.set(task.name, "—");
          continue;
        }
        const result = await task.execute();
        if (task.heavy && result === true) heavyRan = true;
        this.taskStatuses.set(task.name, "✓");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn(TAG, `Task "${task.name}" failed: ${msg}`);
        this.taskStatuses.set(task.name, "✗");
      }
    }

    // Write heartbeat timestamp — doctor checks this on startup
    try {
      writeFileSync(join(agentBridgeHome(), "memory", ".heartbeat"), String(Date.now()), "utf-8");
    } catch { /* best-effort */ }
  }
}
