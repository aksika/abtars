/**
 * incremental-block-delivery.ts — #1619: pipeline-owned controller for bounded
 * master-chat progress blocks and pre-tool semantic segment reconciliation.
 *
 * Provider-neutral: it accepts typed output deltas and an adapter send port;
 * eligibility (direct authenticated master outside the TUI), sanitization, and
 * platform chunk limits are decided by the caller. Only `thinking` deltas are
 * coalesced into timed/size-bounded progress blocks — text is delivered only
 * through semantic segments (`onSegmentBreak`) or the terminal response.
 *
 * Reconciliation rules (design §5):
 *   1. Successfully delivered thinking is progress only and never enters final
 *      answer accounting.
 *   2. Successfully delivered text segments are removed only from a matching
 *      aggregate/prefix; unrelated repeated prose is not heuristically deleted.
 *   3. Failed text segments are retained and prepended/merged into terminal
 *      delivery unless already present in the terminal result.
 *   4. An interim send failure is logged content-free and never rejects the
 *      model turn.
 *   5. Terminal send remains the authoritative fallback.
 */

import { logWarn } from "./logger.js";

const TAG = "incremental-block";

/** Visible prefix distinguishing bounded progress blocks from final text. */
export const THINKING_BLOCK_PREFIX = "💭 ";

/** Default UTF-8 content cap for one progress block (smallest adapter chunk). */
export const DEFAULT_MAX_BLOCK_BYTES = 4000;

/** Default flush cadence for pending thinking (bounded progress interval). */
export const DEFAULT_FLUSH_INTERVAL_MS = 4000;

export interface IncrementalBlockDeliveryOptions {
  /** Adapter send port for bounded progress blocks (already chunked by caller). */
  sendBlock: (text: string) => Promise<unknown>;
  /** Shared outbound cleaning — identical to the terminal path. */
  sanitize: (text: string) => string;
  /** Platform chunk limits; each chunk is sent as its own bounded block. */
  chunkBound?: (text: string) => string[];
  /** UTF-8 content cap for one progress block. */
  maxBlockBytes?: number;
  /** Bounded flush interval for pending thinking. */
  flushIntervalMs?: number;
  /** Content-free failure logging (never logs delivered text). */
  logContentFree?: (detail: string) => void;
}

export class IncrementalBlockDeliveryController {
  private readonly _sendBlock: (text: string) => Promise<unknown>;
  private readonly _sanitize: (text: string) => string;
  private readonly _chunkBound: (text: string) => string[];
  private readonly _maxBlockBytes: number;
  private readonly _flushIntervalMs: number;
  private readonly _logContentFree: (detail: string) => void;

  private _pendingThinking = "";
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _disposed = false;
  /** All progress sends, including sends queued while another is in flight. */
  private _inflight: Promise<void> = Promise.resolve();

  /** Sanitized text segments delivered successfully pre-tool. */
  private readonly _successfulSegments: string[] = [];
  /** Sanitized text segments that failed pre-tool delivery. */
  private readonly _failedSegments: string[] = [];

  constructor(opts: IncrementalBlockDeliveryOptions) {
    this._sendBlock = opts.sendBlock;
    this._sanitize = opts.sanitize;
    this._chunkBound = opts.chunkBound ?? ((t: string) => [t]);
    this._maxBlockBytes = opts.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES;
    this._flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this._logContentFree = opts.logContentFree ?? ((detail) => logWarn(TAG, detail));
    this._startTimer();
  }

  /**
   * Accept a typed output delta. Only thinking is buffered for progress
   * blocks; text deltas are not delivered incrementally by this controller,
   * but a thinking→text transition flushes the pending block so the answer
   * text is never preceded by stale reasoning.
   */
  accept(delta: import("./transport/kiro-transport.js").OutputDelta): void {
    if (this._disposed) return;
    if (delta.kind === "thinking") {
      if (!delta.text) return;
      this._pendingThinking += delta.text;
      this._maybeFlushBySize();
      return;
    }
    if (this._pendingThinking) {
      void this.flush();
    }
  }

  /** Record a successfully delivered pre-tool semantic segment (sanitized). */
  segmentDelivered(sanitizedText: string): void {
    if (this._disposed) return;
    if (sanitizedText) this._successfulSegments.push(sanitizedText);
  }

  /** Record a failed pre-tool semantic segment (sanitized). */
  segmentFailed(sanitizedText: string): void {
    if (this._disposed) return;
    if (sanitizedText) this._failedSegments.push(sanitizedText);
  }

  /** Flush pending thinking (bounded); called by the timer and boundaries. */
  flush(): Promise<void> {
    if (this._disposed) return Promise.resolve();
    const pending = this._pendingThinking;
    if (pending) {
      this._pendingThinking = "";
      const clean = this._sanitize(pending);
      // Queue behind any earlier block. A timer tick or a size boundary can
      // arrive while the adapter is still sending the previous block; those
      // later thoughts must not be dropped or reorder the visible stream.
      const delivery = this._inflight.then(() => this._deliverBlock(clean));
      this._inflight = delivery.catch(() => { /* delivery failures are observed inside _deliverBlock; this only keeps the queue chain alive */ });
    }
    return this._inflight;
  }

  /** Flush on thinking→text transition and before semantic segments. */
  async flushBeforeSemantics(): Promise<void> {
    await this.flush();
  }

  /** Turn end: flush remaining thinking and stop the bounded timer. */
  async end(): Promise<void> {
    this._stopTimer();
    // A send may still be in flight while the final provider event arrives;
    // keep draining until the synchronous producer has no pending thoughts.
    while (this._pendingThinking) await this.flush();
    await this._inflight;
  }

  /** Stop the flush timer and drop any pending progress. Idempotent. */
  async dispose(): Promise<void> {
    this._stopTimer();
    this._disposed = true;
    this._pendingThinking = "";
    await this._inflight;
  }

  /**
   * Reconcile the terminal response with delivered/failed segments so every
   * user-visible text segment is delivered exactly once. Successful segments
   * are removed only from a matching aggregate/prefix; failed segments are
   * prepended unless already present. Thinking never participates.
   */
  reconcileTerminal(finalText: string): string {
    if (this._successfulSegments.length === 0 && this._failedSegments.length === 0) {
      return finalText;
    }
    let text = this._sanitize(finalText);
    for (const segment of this._successfulSegments) {
      const s = this._sanitize(segment);
      if (!s) continue;
      if (text === s) {
        text = "";
        break;
      }
      if (text.startsWith(s)) {
        text = text.slice(s.length).trimStart();
      }
    }
    const missingFailed: string[] = [];
    for (const segment of this._failedSegments) {
      const s = this._sanitize(segment);
      if (!s) continue;
      if (text.includes(s) || missingFailed.includes(s)) continue;
      missingFailed.push(s);
    }
    return [...missingFailed, text].filter(Boolean).join("\n\n").trim();
  }

  /** Test-facing: buffered thinking (not yet flushed). */
  get pendingThinking(): string { return this._pendingThinking; }
  /** Test-facing: successfully delivered segment count. */
  get successfulSegmentCount(): number { return this._successfulSegments.length; }
  /** Test-facing: failed segment count. */
  get failedSegmentCount(): number { return this._failedSegments.length; }
  /** Test-facing: flush timer active. */
  get timerActive(): boolean { return this._timer !== null; }

  private _maybeFlushBySize(): void {
    if (Buffer.byteLength(this._pendingThinking, "utf8") >= this._maxBlockBytes) {
      void this.flush();
    }
  }

  private _deliverBlock(text: string): Promise<void> {
    if (!text) return Promise.resolve();
    const chunks = this._chunkBound(text);
    const chain = chunks
      .map((c) => this._sanitize(c))
      .filter((c) => c.length > 0)
      .map((c) => THINKING_BLOCK_PREFIX + c);
    return chain
      .reduce<Promise<void>>(
        (acc, block) => acc.then(async () => {
          try {
            await this._sendBlock(block);
          } catch {
            this._logContentFree("thinking progress block delivery failed (content-free)");
          }
        }),
        Promise.resolve(),
      )
      .catch(() => { /* each block's send failure is already observed inside the reduce body; this only keeps the outer chain settled */ });
  }

  private _startTimer(): void {
    if (this._timer !== null || this._disposed) return;
    this._timer = setInterval(() => {
      if (this._disposed) return;
      void this.flush();
    }, this._flushIntervalMs);
    // Never keep the process alive for progress blocks.
    if (typeof (this._timer as { unref?: () => void }).unref === "function") {
      (this._timer as { unref: () => void }).unref();
    }
  }

  private _stopTimer(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

/** #1619: exact eligibility for master-chat progress blocks.
 *  #1654: gated additionally on the session's display toggle. */
export function isIncrementalEligible(opts: {
  role: string | undefined;
  isGroup: boolean;
  platform: string;
  showThinking: boolean;
}): boolean {
  return opts.role === "master" && !opts.isGroup && opts.platform !== "tui" && opts.showThinking;
}
