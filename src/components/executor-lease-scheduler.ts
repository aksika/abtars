import { logInfo } from "./logger.js";

const TAG = "lease-scheduler";

export interface CardWakeFn {
  (cardId: number): void;
}

export interface DueQueryFn {
  (): Array<{ attemptId: string; cardId: number; nextEvaluationAt: string }>;
}

export class ExecutorLeaseScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dueQuery: DueQueryFn;
  private wakeCard: CardWakeFn;
  private _stopped = false;
  private currentDueAt: number | null = null;

  constructor(dueQuery: DueQueryFn, wakeCard: CardWakeFn) {
    this.dueQuery = dueQuery;
    this.wakeCard = wakeCard;
  }

  stop(): void {
    this._stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.currentDueAt = null;
  }

  reschedule(): void {
    if (this._stopped) return;

    const dueCards = this.dueQuery();
    if (dueCards.length === 0) {
      this._clearTimer();
      return;
    }

    const now = Date.now();
    let nearest = Infinity;
    for (const card of dueCards) {
      const t = new Date(card.nextEvaluationAt).getTime();
      if (t <= now) {
        this.wakeCard(card.cardId);
      } else if (t < nearest) {
        nearest = t;
      }
    }

    if (nearest === Infinity) {
      this._clearTimer();
      return;
    }

    if (this.currentDueAt !== null && Math.abs(this.currentDueAt - nearest) < 1000) {
      return;
    }

    this._clearTimer();
    const delay = Math.max(0, nearest - now);
    this.currentDueAt = nearest;
    this.timer = setTimeout(() => {
      if (this._stopped) return;
      this.currentDueAt = null;
      this._fireDue();
    }, delay);
  }

  /** Scan all active snapshots and wake overdue cards. Called on boot. */
  bootRecovery(): void {
    if (this._stopped) return;
    const now = Date.now();
    const dueCards = this.dueQuery();
    let overdue = 0;
    for (const card of dueCards) {
      const t = new Date(card.nextEvaluationAt).getTime();
      if (t <= now) {
        this.wakeCard(card.cardId);
        overdue++;
      }
    }
    logInfo(TAG, `Boot recovery: ${overdue}/${dueCards.length} overdue lease(s) woken`);
    this.reschedule();
  }

  private _fireDue(): void {
    if (this._stopped) return;
    const dueCards = this.dueQuery();
    const now = Date.now();
    for (const card of dueCards) {
      const t = new Date(card.nextEvaluationAt).getTime();
      if (t <= now) {
        this.wakeCard(card.cardId);
      }
    }
    this.reschedule();
  }

  private _clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.currentDueAt = null;
  }
}
