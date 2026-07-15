/**
 * tui-frame-writer.ts — Bounded per-connection socket writer (#1339).
 *
 * Moved out of `TuiSocketAdapter._push()` so socket write policy lives in a
 * unit that owns exactly one concrete `net.Socket`. It understands protocol
 * frame delivery classes but knows nothing about Spin, Kanban, or model
 * execution.
 *
 * Invariants (every mutation is covered by property-style queue tests):
 *   - After `socket.write()` returns `false`, no further direct writes happen
 *     until the SAME socket's `drain` event. No producer awaits drain.
 *   - `queuedFrames` and `queuedBytes` never exceed the configured limits.
 *   - Control and terminal frames survive saturation by evicting replaceable
 *     data (typing → status → nonterminal activity → model deltas).
 *   - A stream whose delta is dropped is marked truncated; exactly one
 *     `chunk-end` with `reason: "truncated"` is emitted and later deltas
 *     for that stream are rejected.
 *   - `close()` is idempotent, removes writer listeners, clears queued data,
 *     and permanently invalidates the instance.
 *
 * The adapter supplies `isCurrent()` so a stale writer (a superseded
 * connection) can never flush into a newer connection or attachment.
 */

import * as net from "node:net";
import { encodeFrame, type TuiServerFrame } from "./tui-protocol.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";

const TAG = "tui-writer";

// ── Tunable limits (defaults used in production; tests inject overrides) ──

export const MAX_QUEUED_FRAMES = 256;
export const MAX_QUEUED_BYTES = 512 * 1024;
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_COALESCED_CHUNK_BYTES = 16 * 1024;

/** Visible marker appended to truncated model text. */
export const TRUNCATION_MARKER = "\n[… output truncated]";

export type TuiFrameClass =
  | "control"     // ready, error — never evicted
  | "terminal"    // final message, chunk-end, steer-ack, terminal activity
  | "snapshot"    // activity-snapshot (recovery) — coalesce to latest
  | "status"      // runtime status — coalesce to latest revision
  | "progress"    // nonterminal incremental activity — coalesce per card
  | "chunk"       // model stream delta — coalesce per stream, lowest keep
  | "typing";     // typing indicator — lowest priority

/** Eviction order from lowest priority (drop first) to highest. */
const EVICT_ORDER: TuiFrameClass[] = ["typing", "status", "progress", "chunk"];

export type TuiFrameWriterResult = "written" | "queued" | "coalesced" | "dropped";

export interface TuiFrameWriterOptions {
  /** Stop direct writes after `write(false)`; resume only on the same drain. */
  isCurrent: () => boolean;
  /** Writer dropped incremental activity (overflow) — adapter marks dirty. */
  onSemanticOverflow: () => void;
  /** Socket became writable again — adapter may enqueue a recovery snapshot. */
  onWritable: () => void;
  /** Test-only limit overrides. Not used at runtime. */
  maxFrames?: number;
  maxBytes?: number;
  maxFrameBytes?: number;
  maxChunkBytes?: number;
}

interface QueuedFrame {
  frame: TuiServerFrame;
  cls: TuiFrameClass;
  bytes: number;
  /** Coalescing key for `chunk`. */
  streamId?: string;
  /** Coalescing key for `progress` activity. */
  cardId?: number;
}

export class TuiFrameWriter {
  private readonly _socket: net.Socket;
  private readonly _opts: TuiFrameWriterOptions;
  private readonly _maxFrames: number;
  private readonly _maxBytes: number;
  private readonly _maxFrameBytes: number;
  private readonly _maxChunkBytes: number;

  private _queue: QueuedFrame[] = [];
  private _queuedBytes = 0;
  private _queuedFrames = 0;
  private _writable = true;
  private _closed = false;

  /** Streams whose output was truncated (deltas dropped). */
  private readonly _truncatedStreams = new Set<string>();

  private readonly _onDrain: () => void;
  private readonly _onError: (err: Error) => void;

  constructor(socket: net.Socket, opts: TuiFrameWriterOptions) {
    this._socket = socket;
    this._opts = opts;
    this._maxFrames = opts.maxFrames ?? MAX_QUEUED_FRAMES;
    this._maxBytes = opts.maxBytes ?? MAX_QUEUED_BYTES;
    this._maxFrameBytes = opts.maxFrameBytes ?? MAX_FRAME_BYTES;
    this._maxChunkBytes = opts.maxChunkBytes ?? MAX_COALESCED_CHUNK_BYTES;

    this._onDrain = () => {
      if (this._closed || !this._opts.isCurrent()) return;
      this._writable = true;
      this._flush();
      // Adapter may now enqueue an authoritative recovery snapshot.
      this._opts.onWritable();
    };
    this._onError = (err: Error) => {
      if (this._closed) return;
      logAndSwallow(TAG, "socket error", err);
    };
    socket.on("drain", this._onDrain);
    socket.on("error", this._onError);
  }

  // ── Public surface ─────────────────────────────────────────────────

  get queuedFrames(): number { return this._queuedFrames; }
  get queuedBytes(): number { return this._queuedBytes; }
  get isClosed(): boolean { return this._closed; }
  get truncatedStreamCount(): number { return this._truncatedStreams.size; }
  /** Test-facing: snapshot of currently queued frames (oldest first). */
  get queuedFrameList(): ReadonlyArray<TuiServerFrame> { return this._queue.map((q) => q.frame); }

  enqueue(frame: TuiServerFrame): TuiFrameWriterResult {
    if (this._closed || !this._opts.isCurrent()) return "dropped";

    const clsInfo = classify(frame);

    // A delta for an already-truncated stream is rejected — the truncated
    // terminal was already emitted and missing text is not replayable.
    if (clsInfo.cls === "chunk" && clsInfo.streamId !== undefined) {
      if (this._truncatedStreams.has(clsInfo.streamId)) return "dropped";
    }

    // Bound oversized individual frames to an explicit representation.
    let working = frame;
    if (encodedBytes(frame) > this._maxFrameBytes) {
      working = boundFrame(frame, this._maxFrameBytes, this._maxChunkBytes);
      if (frame.t === "chunk" && frame.id) {
        // Capped delta loses tail → mark the stream truncated.
        this._markTruncated(frame.id);
      }
    }

    // Type-specific coalescing (replaceable frames).
    if (this._tryCoalesce(working, clsInfo)) return "coalesced";

    // Direct write while writable. A `false` result means the bytes are
    // already accepted by Node's internal buffer; we mark blocked and do
    // NOT enqueue that frame again — backpressure is now the OS's problem.
    if (this._writable) {
      const ok = this._socket.write(encodeFrame(working));
      if (!ok) this._writable = false;
      return "written";
    }

    // Blocked: queue with bounds + deterministic eviction.
    const itemBytes = encodedBytes(working);
    if (!this._canAccept(itemBytes)) {
      const made = this._evictFor(itemBytes);
      if (!made) {
        if (clsInfo.cls === "chunk" && clsInfo.streamId !== undefined) {
          this._markTruncated(clsInfo.streamId);
          return "dropped";
        }
        if (clsInfo.cls === "progress") {
          this._opts.onSemanticOverflow();
          return "dropped";
        }
        if (clsInfo.cls === "typing" || clsInfo.cls === "status") {
          return "dropped";
        }
        // Preserve-class frame with no replaceable room left: last-resort
        // evict the oldest queued frame of any class to make room.
        if (!this._forceEvictOne()) return "dropped";
      }
    }

    this._queue.push({
      frame: working,
      cls: clsInfo.cls,
      bytes: itemBytes,
      streamId: clsInfo.streamId,
      cardId: clsInfo.cardId,
    });
    this._queuedBytes += itemBytes;
    this._queuedFrames = this._queue.length;
    return "queued";
  }

  /** Discard queued incremental activity for the current attachment. */
  dropActivity(): void {
    if (this._closed) return;
    this._queue = this._queue.filter((q) => q.cls !== "progress");
    this._recomputeBytes();
  }

  /**
   * Clear attachment-scoped queued frames (status/activity/snapshot/typing)
   * while leaving connection control (ready/error) and terminal frames valid.
   * Called on attach / session switch.
   */
  clearAttachment(): void {
    if (this._closed) return;
    this._queue = this._queue.filter((q) => q.cls === "control" || q.cls === "terminal");
    this._recomputeBytes();
  }

  /** Idempotent. Remove writer listeners, clear queued data, invalidate. */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._writable = false;
    try { this._socket.removeListener("drain", this._onDrain); } catch { /* best effort */ }
    try { this._socket.removeListener("error", this._onError); } catch { /* best effort */ }
    this._queue = [];
    this._queuedBytes = 0;
    this._queuedFrames = 0;
    this._truncatedStreams.clear();
  }

  // ── Internals ─────────────────────────────────────────────────────

  private _canAccept(need: number): boolean {
    return this._queuedBytes + need <= this._maxBytes
      && this._queue.length + 1 <= this._maxFrames;
  }

  private _recomputeBytes(): void {
    this._queuedBytes = this._queue.reduce((sum, q) => sum + q.bytes, 0);
    this._queuedFrames = this._queue.length;
  }

  /** Emit exactly one truncated terminal for a stream and reject later deltas. */
  private _markTruncated(streamId: string): void {
    if (this._truncatedStreams.has(streamId)) return;
    this._truncatedStreams.add(streamId);
    const terminal: TuiServerFrame = { t: "chunk-end", id: streamId, reason: "truncated" };
    // Enqueue through the normal path (preserve-class, no re-entrant mark).
    this.enqueue(terminal);
  }

  private _applyEvictSideEffects(q: QueuedFrame): void {
    if (q.cls === "chunk" && q.streamId !== undefined) {
      this._markTruncated(q.streamId);
    } else if (q.cls === "progress") {
      this._opts.onSemanticOverflow();
    }
  }

  /** Evict lowest-priority replaceable frames until `need` fits. */
  private _evictFor(need: number): boolean {
    for (const cls of EVICT_ORDER) {
      let idx = this._queue.findIndex((q) => q.cls === cls);
      while (idx !== -1) {
        const removed = this._queue[idx]!;
        this._queue.splice(idx, 1);
        this._queuedBytes -= removed.bytes;
        this._applyEvictSideEffects(removed);
        if (this._canAccept(need)) return true;
        idx = this._queue.findIndex((q) => q.cls === cls);
      }
    }
    return this._canAccept(need);
  }

  /** Last-resort eviction of the oldest queued frame (any class). */
  private _forceEvictOne(): boolean {
    const removed = this._queue.shift();
    if (!removed) return false;
    this._queuedBytes -= removed.bytes;
    this._applyEvictSideEffects(removed);
    return true;
  }

  private _flush(): void {
    while (this._queue.length > 0) {
      const item = this._queue[0]!;
      const ok = this._socket.write(encodeFrame(item.frame));
      this._queue.shift();
      this._queuedBytes -= item.bytes;
      if (!ok) {
        this._writable = false;
        break;
      }
    }
    this._queuedFrames = this._queue.length;
  }

  /**
   * Coalesce a replaceable frame into an existing queued frame. Returns true
   * if the frame was merged (caller should return "coalesced").
   */
  private _tryCoalesce(frame: TuiServerFrame, clsInfo: ReturnType<typeof classify>): boolean {
    switch (clsInfo.cls) {
      case "chunk": {
        const streamId = clsInfo.streamId!;
        for (let i = this._queue.length - 1; i >= 0; i--) {
          const q = this._queue[i]!;
          if (q.cls === "chunk" && q.streamId === streamId) {
            const existing = (q.frame as { delta: string }).delta;
            const combined = existing + (frame as { delta: string }).delta;
            const capped = truncateUtf8(combined, this._maxChunkBytes);
            (q.frame as { delta: string }).delta = capped;
            q.bytes = encodedBytes(q.frame);
            this._queuedBytes = this._queue.reduce((s, x) => s + x.bytes, 0);
            if (Buffer.byteLength(combined, "utf8") > this._maxChunkBytes) {
              // Coalesced cap reached → remaining tail is lost → truncated.
              this._markTruncated(streamId);
            }
            return true;
          }
        }
        return false;
      }
      case "status":
      case "snapshot":
      case "typing": {
        const i = this._queue.findIndex((q) => q.cls === clsInfo.cls);
        if (i === -1) return false;
        this._replace(i, frame, clsInfo.cls);
        return true;
      }
      case "progress": {
        const cardId = clsInfo.cardId;
        if (cardId === undefined) return false;
        for (let i = this._queue.length - 1; i >= 0; i--) {
          const q = this._queue[i]!;
          if (q.cls === "progress" && q.cardId === cardId) {
            this._replace(i, frame, "progress", cardId);
            return true;
          }
        }
        return false;
      }
      default:
        return false;
    }
  }

  private _replace(i: number, frame: TuiServerFrame, cls: TuiFrameClass, cardId?: number): void {
    const old = this._queue[i]!;
    const b = encodedBytes(frame);
    this._queuedBytes -= old.bytes;
    this._queue[i] = {
      frame,
      cls,
      bytes: b,
      streamId: old.streamId,
      cardId: cardId ?? old.cardId,
    };
    this._queuedBytes += b;
    this._queuedFrames = this._queue.length;
  }
}

// ── Free helpers ──────────────────────────────────────────────────────

function encodedBytes(frame: TuiServerFrame): number {
  return Buffer.byteLength(encodeFrame(frame), "utf8");
}

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

/** Recursively truncate every string field to `maxBytes` (UTF-8 safe). */
function truncateStringsDeep<T>(value: T, maxBytes: number): T {
  if (typeof value === "string") {
    return (value.length <= maxBytes ? value : truncateUtf8(value, maxBytes)) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => truncateStringsDeep(v, maxBytes)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateStringsDeep(v, maxBytes);
    }
    return out as unknown as T;
  }
  return value;
}

function classify(frame: TuiServerFrame): {
  cls: TuiFrameClass;
  streamId?: string;
  cardId?: number;
} {
  switch (frame.t) {
    case "ready":
    case "error":
      return { cls: "control" };
    case "message":
    case "chunk-end":
    case "steer-ack":
      return { cls: "terminal" };
    case "activity-snapshot":
      return { cls: "snapshot" };
    case "status":
      return { cls: "status" };
    case "typing":
    case "tool-start":
      return { cls: "typing" };
    case "chunk":
      return { cls: "chunk", streamId: frame.id };
    case "activity": {
      const e = frame.event;
      const terminal =
        e.kind === "card.completed" || e.kind === "card.failed" ||
        e.kind === "card.delivered" || e.kind === "execution.completed" ||
        e.kind === "execution.failed";
      if (terminal) return { cls: "terminal" };
      return { cls: "progress", cardId: e.cardId };
    }
  }
}

/**
 * Convert an oversized frame to a bounded explicit representation. The result
 * is guaranteed to encode within `maxFrameBytes`.
 */
function boundFrame(frame: TuiServerFrame, maxFrameBytes: number, _maxChunkBytes: number): TuiServerFrame {
  const make = (budget: number): TuiServerFrame => {
    switch (frame.t) {
      case "message":
        return { t: "message", role: frame.role, markdown: truncateUtf8(frame.markdown, budget) + TRUNCATION_MARKER };
      case "chunk":
        return { t: "chunk", id: frame.id, delta: truncateUtf8(frame.delta, budget) };
      case "activity":
        return { t: "activity", sequence: frame.sequence, event: truncateStringsDeep(frame.event, Math.min(budget, 512)) };
      case "activity-snapshot":
        return { t: "activity-snapshot", sequence: frame.sequence, snapshot: truncateStringsDeep(frame.snapshot, 512) };
      case "status":
        return { t: "status", status: truncateStringsDeep(frame.status, 256) };
      case "ready":
        return { t: "ready", sessionLabel: truncateUtf8(frame.sessionLabel, budget), sessionId: frame.sessionId };
      case "error":
        return { t: "error", message: truncateUtf8(frame.message, budget) };
      case "steer-ack":
        return { t: "steer-ack", status: frame.status, instructionId: frame.instructionId, message: truncateUtf8(frame.message, budget) };
      case "tool-start":
        return { t: "tool-start", id: frame.id, name: truncateUtf8(frame.name, budget) };
      case "chunk-end":
      case "typing":
        return frame;
    }
  };
  let budget = maxFrameBytes;
  for (;;) {
    const candidate = make(budget);
    if (encodedBytes(candidate) <= maxFrameBytes) return candidate;
    budget = Math.floor(budget * 0.75);
    if (budget <= 0) return make(0);
  }
}
