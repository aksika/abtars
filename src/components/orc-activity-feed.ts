import { logWarn, logDebug } from "./logger.js";

const TAG = "orc-activity";
const MAX_PENDING = 64;
const TRUNCATE_STRING = 200;

export type CardActivityKind = "card.queued" | "card.running" | "card.completed" | "card.failed" | "card.delivered";

export type OrcActivityPayload =
  | { kind: "execution.started" }
  | { kind: "execution.completed"; summary: string }
  | { kind: "execution.failed"; error: string }
  | { kind: CardActivityKind; title: string; status: string }
  | { kind: "channel.message"; from: string; to: string; message: string };

export interface ActivityBase {
  readonly sequence: number;
  readonly timestamp: number;
  readonly sessionId: string;
  readonly executionId: string;
  readonly rootCardId?: number;
  readonly cardId?: number;
  readonly parentCardId?: number;
}

export type OrcActivityEvent = ActivityBase & OrcActivityPayload;

export type UnsequencedOrcActivityEvent = Omit<OrcActivityEvent, "sequence">;

export interface OrcActivityFilter {
  sessionId: string;
  executionId?: string;
}

export type OrcActivityListener = (event: OrcActivityEvent) => void;

const TERMINAL_CARD_KINDS = new Set<CardActivityKind>(["card.completed", "card.failed", "card.delivered"]);

function isCardKind(k: string): k is CardActivityKind {
  return k.startsWith("card.");
}

function truncate(s: string, max = TRUNCATE_STRING): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

interface Subscriber {
  filter: OrcActivityFilter;
  listener: OrcActivityListener;
  /** #1339: invoked when this subscriber's queue overflows (resync request). */
  onOverflow?: () => void;
  pending: OrcActivityEvent[];
  dirty: boolean;
  scheduled: boolean;
}

export class OrcActivityFeed {
  private _nextSeq = 1;
  private _subscribers: Subscriber[] = [];

  /** Highest sequence number assigned so far (watermark for recovery). */
  get currentSequence(): number {
    return this._nextSeq - 1;
  }

  publish(event: UnsequencedOrcActivityEvent): void {
    const seq = this._nextSeq++;
    const full: OrcActivityEvent = {
      ...event,
      sequence: seq,
      timestamp: event.timestamp ?? Date.now(),
      executionId: event.executionId,
    };

    for (const sub of this._subscribers) {
      if (!this._matches(sub.filter, full)) continue;

      if (isCardKind(full.kind) && !TERMINAL_CARD_KINDS.has(full.kind) && full.cardId !== undefined) {
        const lastIdx = sub.pending.length - 1;
        if (lastIdx >= 0) {
          const last = sub.pending[lastIdx];
          if (last.kind === full.kind && last.cardId === full.cardId) {
            sub.pending[lastIdx] = full;
            continue;
          }
        }
      }

      if (sub.pending.length >= MAX_PENDING) {
        const dropIdx = sub.pending.findIndex(e => isCardKind(e.kind) && !TERMINAL_CARD_KINDS.has(e.kind));
        if (dropIdx >= 0) {
          sub.pending.splice(dropIdx, 1);
        } else {
          sub.pending.shift();
        }
        sub.dirty = true;
        // #1339: surface overflow so the consumer can request a fresh snapshot.
        sub.onOverflow?.();
      }

      sub.pending.push(full);
      this._schedule(sub);
    }
  }

  subscribe(filter: OrcActivityFilter, listener: OrcActivityListener, onOverflow?: () => void): () => void {
    const sub: Subscriber = { filter, listener, onOverflow, pending: [], dirty: false, scheduled: false };
    this._subscribers.push(sub);
    logDebug(TAG, `subscribe session=${filter.sessionId} executionId=${filter.executionId ?? "(follow)"}`);
    return () => {
      this._subscribers = this._subscribers.filter(s => s !== sub);
      logDebug(TAG, `unsubscribe session=${filter.sessionId}`);
    };
  }

  get pendingSubscribers(): number {
    return this._subscribers.length;
  }

  private _matches(filter: OrcActivityFilter, event: OrcActivityEvent): boolean {
    if (event.sessionId !== filter.sessionId) return false;
    if (filter.executionId !== undefined) {
      return event.executionId === filter.executionId;
    }
    return event.kind === "execution.started";
  }

  private _schedule(sub: Subscriber): void {
    if (sub.scheduled) return;
    sub.scheduled = true;
    queueMicrotask(() => {
      sub.scheduled = false;
      const batch = sub.pending.splice(0);
      if (batch.length === 0) return;
      try {
        for (const event of batch) {
          sub.listener(event);
        }
      } catch (err) {
        logWarn(TAG, `listener error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }
}
