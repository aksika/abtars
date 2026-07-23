import { logInfo, logWarn, logDebug } from "./logger.js";
import { isWsl, WSL_STANDBY_THRESHOLD_MS } from "./platform-detect.js";
import { updateLastHeartbeat, updateBridgeLockField } from "./transport/bridge-lock-transport.js";
import type { HeartbeatTask, HeartbeatTaskOutcome, HeartbeatTaskStatus } from "../types/index.js";

export type HeartbeatConfig = {
  enabled: boolean;
  intervalMs: number;
  bridgeLockPath: string;
  sleepActive?: () => boolean;
  onStandbyResume?: (gapMs: number) => void;
  onTick?: () => void;
};

const TAG = "heartbeat";
const MIN_GUARD_MS = 3 * 60 * 1000;

import type { ITaskSlot } from "./skeleton.js";

export class HeartbeatSystem implements ITaskSlot {
  private timer: ReturnType<typeof setInterval> | null = null;
  private initTimeout: ReturnType<typeof setTimeout> | null = null;
  private tasks: HeartbeatTask[] = [];
  private running = false;
  private lastTickAt = 0;
  private tickCount = 0;
  private readonly taskStatuses = new Map<string, HeartbeatTaskStatus>();
  private _cronQueue: { enqueue: (entry: any, cb: any) => void } | null = null;
  private _notify: ((chatId: string, text: string) => void) | null = null;

  constructor(private config: HeartbeatConfig) {}

  setCronQueue(queue: { enqueue: (entry: any, cb: any) => void }): void { this._cronQueue = queue; }
  get cronQueue() { return this._cronQueue; }

  setNotify(fn: (chatId: string, text: string) => void): void { this._notify = fn; }
  get notify() { return this._notify; }

  registerTask(task: HeartbeatTask): void {
    this.tasks.push(task);
    this.taskStatuses.set(task.name, { marker: "?", state: "never" });
  }

  start(): void {
    if (this.running) return;
    if (!this.config.enabled) {
      logInfo(TAG, "Heartbeat disabled by configuration");
      return;
    }

    this.running = true;
    const taskNames = this.tasks.map((t) => t.name).join(", ");
    const iv = this.config.intervalMs;

    const now = Date.now();
    let nextBoundary = Math.ceil(now / iv) * iv;
    let delay = nextBoundary - now;
    if (delay < MIN_GUARD_MS) {
      nextBoundary += iv;
      delay += iv;
    }

    const firstTickAt = new Date(nextBoundary).toTimeString().slice(0, 8);
    logInfo(TAG, `Starting heartbeat — interval=${iv}ms, first tick at ${firstTickAt} (${Math.round(delay / 1000)}s), tasks=[${taskNames}]`);

    this.lastTickAt = now;
    this.initTimeout = setTimeout(() => {
      this.lastTickAt = Date.now();
      void this.tick();
      this.timer = setInterval(() => {
        void this.tick();
      }, iv);
    }, delay);
  }

  stop(): void {
    if (!this.running) return;
    if (this.initTimeout !== null) { clearTimeout(this.initTimeout); this.initTimeout = null; }
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.running = false;
    logInfo(TAG, "Heartbeat stopped");
  }

  get isRunning(): boolean { return this.running; }

  get intervalMs(): number { return this.config.intervalMs; }

  getTaskNames(): string[] {
    return this.tasks.map(t => t.name);
  }

  getTaskStatuses(): ReadonlyMap<string, HeartbeatTaskStatus> {
    return this.taskStatuses;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const gap = now - this.lastTickAt;
    this.lastTickAt = now;

    const standbyThresholdMs = isWsl() ? WSL_STANDBY_THRESHOLD_MS : this.config.intervalMs * 3;
    if (gap > standbyThresholdMs) {
      const gapMin = Math.round(gap / 60000);
      logInfo(TAG, `Standby resume detected — suspended ${gapMin}min`);
      updateLastHeartbeat();
      if (this.config.onStandbyResume) {
        this.config.onStandbyResume(gap);
        return;
      }
    }

    logDebug(TAG, `Tick — executing ${this.tasks.length} task(s)`);
    let heavyRan = false;
    const sleepBlocking = this.config.sleepActive?.() ?? false;

    for (const task of this.tasks) {
      try {
        if (task.heavy && (heavyRan || sleepBlocking)) {
          logDebug(TAG, `Skipping heavy task "${task.name}" — ${sleepBlocking ? "sleep in progress" : "another heavy task already ran"}`);
          this.taskStatuses.set(task.name, { marker: "—", state: "skipped" });
          continue;
        }
        const result: HeartbeatTaskOutcome = await task.execute();
        if (task.heavy && result.state === "ran") heavyRan = true;
        this.taskStatuses.set(task.name, {
          marker: result.state === "ran" ? "✓" : "—",
          state: result.state,
          detail: result.detail,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : JSON.stringify(err);
        logWarn(TAG, `Task "${task.name}" failed: ${msg}`);
        this.taskStatuses.set(task.name, { marker: "✗", state: "failed", detail: msg.slice(0, 500) });
      }
    }

    updateLastHeartbeat();

    this.tickCount++;
    if (this.tickCount % 60 === 0) {
      const heap = Math.round(process.memoryUsage().heapUsed / 1048576);
      updateBridgeLockField("heapUsedMB", heap);
      if (heap > 820) {
        logWarn(TAG, `Heap high: ${heap}MB / 1024MB (80%+)`);
      } else {
        logDebug(TAG, `Heap: ${heap}MB / 1024MB`);
      }
    }

    this.config.onTick?.();
  }
}

let _instance: HeartbeatSystem | null = null;
export function setHeartbeatInstance(hb: HeartbeatSystem): void { _instance = hb; }
export function getHeartbeatInstance(): HeartbeatSystem | null { return _instance; }