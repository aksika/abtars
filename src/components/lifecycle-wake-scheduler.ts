import { logAndSwallow } from "./log-and-swallow.js";

const TAG = "lifecycle-wake";

export type LifecycleDueSourceId =
  | "executor-lease"
  | "kanban-retry"
  | "task-admission"
  | "run-deadline";

export interface LifecycleDueItem {
  key: string;
  dueAt: number;
}

export interface LifecycleDueSource {
  id: LifecycleDueSourceId;
  listDueItems(): LifecycleDueItem[];
  wakeDue(now: number): void | Promise<void>;
}

/** Platform maximum setTimeout delay (24.8 days); distant deadlines re-arm. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** Bounded passes per scan so a wake that keeps mutating durable state cannot spin forever. */
const MAX_SCAN_PASSES = 16;
/** Re-arm skip tolerance: a re-armed timer within 1s of the current one is a no-op. */
const REARM_TOLERANCE_MS = 1000;

/**
 * #1539: one process-wide due-time scheduler. Owns a single timer armed for
 * the earliest registered durable due item across four sources: executor
 * leases, Kanban retry dates, task admission/retry times, and active-run
 * deadlines. Wakes are level-triggered and idempotent: wakeDue rescans
 * durable state and requests the owning pump; it never carries executable
 * payloads.
 */
export class LifecycleWakeScheduler {
  private readonly sources = new Map<LifecycleDueSourceId, LifecycleDueSource>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armedAt: number | null = null;
  private _stopped = false;
  private _running: Promise<void> | null = null;
  private _rescan = false;
  private readonly waking = new Set<LifecycleDueSourceId>();

  register(source: LifecycleDueSource): () => void {
    this.sources.set(source.id, source);
    return () => {
      this.sources.delete(source.id);
      if (this._stopped) return;
      if (this._running) {
        this._rescan = true;
        return;
      }
      void this.scan();
    };
  }

  /** A durable source mutated: rescan overdue items and re-arm the earliest. */
  sourceChanged(sourceId: LifecycleDueSourceId): void {
    if (this._stopped) return;
    if (!this.sources.has(sourceId)) return;
    if (this._running) {
      this._rescan = true;
      return;
    }
    void this.scan();
  }

  /**
   * Boot recovery scan: wake every overdue item, then arm the earliest future
   * item. The initial scan runs after recovery has rebuilt ownership.
   */
  async start(): Promise<void> {
    if (this._stopped) return;
    if (this._running) {
      this._rescan = true;
      await this._running;
      return;
    }
    this._running = this.scanPasses();
    try {
      await this._running;
    } finally {
      this._running = null;
    }
  }

  stop(): void {
    this._stopped = true;
    this._rescan = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.armedAt = null;
    this.waking.clear();
  }

  /**
   * R3: bounded heartbeat safety scan. A no-op whenever the scheduler is
   * healthy (a scan is running or a timer is armed). No test may depend on it.
   */
  safetyScan(): void {
    if (this._stopped || this._running || this.timer !== null) return;
    void this.scan();
  }

  get isHealthy(): boolean {
    return this._running !== null || this.timer !== null || this.sources.size === 0;
  }

  private scan(): Promise<void> {
    if (this._stopped) return Promise.resolve();
    if (this._running) {
      this._rescan = true;
      return this._running;
    }
    this._running = this.scanPasses();
    const p = this._running;
    return p.finally(() => {
      if (this._running === p) this._running = null;
    });
  }

  private async scanPasses(): Promise<void> {
    let passes = 0;
    do {
      this._rescan = false;
      await this.wakeOverdue();
      passes++;
    } while (this._rescan && passes < MAX_SCAN_PASSES);
    if (this._rescan) {
      // Mutation storm guard: keep a minimal re-arm instead of looping forever.
      logAndSwallow(TAG, "scanPasses", new Error("due-source mutation storm — arming with minimal delay"));
    }
    this.armEarliest();
  }

  private async wakeOverdue(): Promise<void> {
    const now = Date.now();
    for (const source of this.sources.values()) {
      if (this.waking.has(source.id)) continue;
      const due = this.overdueItems(source, now);
      if (due.length === 0) continue;
      this.waking.add(source.id);
      try {
        // Wakes are level-triggered: the source rescans durable state itself.
        await source.wakeDue(now);
      } catch (err) {
        logAndSwallow(TAG, `wakeDue:${source.id}`, err);
      } finally {
        this.waking.delete(source.id);
      }
    }
  }

  private overdueItems(source: LifecycleDueSource, now: number): LifecycleDueItem[] {
    let items: LifecycleDueItem[];
    try {
      items = source.listDueItems();
    } catch (err) {
      logAndSwallow(TAG, `listDueItems:${source.id}`, err);
      return [];
    }
    return items.filter(i => Number.isFinite(i.dueAt) && i.dueAt <= now);
  }

  private armEarliest(): void {
    if (this._stopped) return;
    const now = Date.now();
    let nearest = Infinity;
    for (const source of this.sources.values()) {
      let items: LifecycleDueItem[];
      try {
        items = source.listDueItems();
      } catch (err) {
        logAndSwallow(TAG, `arm listDueItems:${source.id}`, err);
        continue;
      }
      for (const item of items) {
        if (!Number.isFinite(item.dueAt)) continue;
        // Invalid or already-due dates are excluded here: overdue items were
        // woken by the scan pass, and a dueAt that is still <= now must not
        // arm a tight loop.
        if (item.dueAt > now && item.dueAt < nearest) nearest = item.dueAt;
      }
    }
    if (nearest === Infinity) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.armedAt = null;
      return;
    }
    if (this.armedAt !== null && Math.abs(this.armedAt - nearest) < REARM_TOLERANCE_MS) return;
    if (this.timer) clearTimeout(this.timer);
    this.armedAt = nearest;
    const delay = Math.max(0, Math.min(nearest - now, MAX_TIMEOUT_MS));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.armedAt = null;
      if (this._stopped) return;
      void this.scan();
    }, delay);
  }
}
