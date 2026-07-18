/**
 * session-output-feed.ts — TUI live attached-session output mirroring (#1338).
 *
 * A process-local, non-persistent, bounded feed of model output events for
 * local Spin executions. Publication happens whether or not a TUI is attached;
 * with no subscribers it is a cheap no-op. The socket adapter subscribes to
 * exactly the session currently selected by `/session N` or `--orc`.
 *
 * Payloads are bounded at event boundaries. Thinking, prompts, tool
 * arguments/results, and secrets are never published here — only `text`
 * deltas, bounded tool-start names, and terminal markers.
 */

import { logWarn } from "./logger.js";

const TAG = "session-output";

/** Per-delta text cap (UTF-8). The #1339 writer further coalesces per stream. */
export const MAX_DELTA_BYTES = 4096;
/** Bounded, allowlisted-by-truncation tool name cap. */
export const MAX_TOOL_NAME_BYTES = 128;

export type SessionOutputStreamKind = "text" | "thinking";
export type SessionOutputEndReason = "complete" | "error" | "cancelled" | "truncated";

/** Call-local observer contract the transports invoke during a model call. */
export interface OutputObserver {
  onDelta?(event: { kind: SessionOutputStreamKind; text: string }): void;
  onToolStart?(event: { name: string }): void;
  end?(reason: SessionOutputEndReason): void;
}

export type SessionOutputEvent =
  | { type: "start"; sessionId: string; executionId: string; streamId: string }
  | { type: "delta"; sessionId: string; executionId: string; streamId: string; text: string }
  | { type: "tool-start"; sessionId: string; executionId: string; streamId: string; name: string }
  | { type: "end"; sessionId: string; executionId: string; streamId: string; reason: SessionOutputEndReason };

export type SessionOutputFilter = { sessionId: string };
export type SessionOutputListener = (event: SessionOutputEvent) => void;

function truncateUtf8(s: string, maxBytes: number): string {
  let res = "";
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > maxBytes) break;
    res += ch;
    bytes += b;
  }
  return res;
}

let _streamCounter = 0;
function makeStreamId(): string {
  _streamCounter = (_streamCounter + 1) >>> 0;
  return `st_${_streamCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Concrete observer that publishes bounded events to a `SessionOutputFeed`. */
export class SessionOutputObserver implements OutputObserver {
  private _valid = true;
  private _ended = false;
  readonly streamId: string;

  constructor(
    private readonly _feed: SessionOutputFeed,
    private readonly _ids: { sessionId: string; executionId: string },
  ) {
    this.streamId = makeStreamId();
    this._feed.publish({ type: "start", ..._ids, streamId: this.streamId });
  }

  onDelta(event: { kind: SessionOutputStreamKind; text: string }): void {
    if (!this._valid || this._ended) return;
    // Thinking is excluded from TUI frames by design — only `text` streams.
    if (event.kind !== "text") return;
    const text = truncateUtf8(event.text, MAX_DELTA_BYTES);
    if (!text) return;
    this._feed.publish({ type: "delta", ...this._ids, streamId: this.streamId, text });
  }

  onToolStart(event: { name: string }): void {
    if (!this._valid || this._ended) return;
    const name = truncateUtf8(event.name, MAX_TOOL_NAME_BYTES);
    if (!name) return;
    this._feed.publish({ type: "tool-start", ...this._ids, streamId: this.streamId, name });
  }

  end(reason: SessionOutputEndReason): void {
    if (!this._valid || this._ended) return;
    this._ended = true;
    this._feed.publish({ type: "end", ...this._ids, streamId: this.streamId, reason });
  }

  /** Mark the observer dead; further publications are no-ops. */
  invalidate(): void {
    this._valid = false;
  }
}

interface Subscriber {
  filter: SessionOutputFilter;
  listener: SessionOutputListener;
}

/** Process-local, bounded, non-persistent output feed. */
export class SessionOutputFeed {
  private _subs: Subscriber[] = [];

  /** Publish an event. Cheap no-op when no subscriber matches. */
  publish(event: SessionOutputEvent): void {
    if (this._subs.length === 0) return;
    for (const sub of this._subs) {
      if (sub.filter.sessionId !== event.sessionId) continue;
      try {
        sub.listener(event);
      } catch (err) {
        logWarn(TAG, `listener error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Subscribe to events for one session. Returns an unsubscribe function. */
  subscribe(filter: SessionOutputFilter, listener: SessionOutputListener): () => void {
    const sub: Subscriber = { filter, listener };
    this._subs.push(sub);
    return () => {
      this._subs = this._subs.filter((s) => s !== sub);
    };
  }

  get subscriberCount(): number {
    return this._subs.length;
  }
}

/** Create a fresh call-local observer (own streamId) for one model call/round. */
export function createOutputObserver(
  feed: SessionOutputFeed,
  ids: { sessionId: string; executionId: string },
): SessionOutputObserver {
  return new SessionOutputObserver(feed, ids);
}
