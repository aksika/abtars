/**
 * tui-socket-adapter.ts — Bridge-side socket server for the TUI client (#1315).
 *
 * Model B (client/server): the bridge never renders to a terminal — it only
 * speaks a wire protocol over a unix-domain socket at ~/.abtars/tui.sock.
 * The TUI client (abtars tui) owns the PTY and pi-tui rendering.
 *
 * Lifecycle mirrors the browser-ipc-server socket handling EXCEPT:
 *   - We explicit `fs.chmodSync(socketPath, 0o600)` after listen resolves.
 *     browser-ipc-server relies on the boot umask (0o077). TUI is master-only
 *     and security-sensitive; we set perms directly so the test below is real
 *     and the guarantee doesn't depend on the process umask.
 *   - We do NOT import the browser class to avoid coupling.
 *
 * Single-client: one live connection at a time. New-attach-wins: a new
 * connection sends `error` to the existing client and evicts it. The
 * evicted client treats the post-`ready` error as a clean detach.
 *
 * Recovery-handler pattern: onMessage is set at construction to the
 * recovery handler. wireTui() swaps in handleInboundMessage after
 * pipelineDeps is ready. We never call handleInboundMessage at
 * construction (would crash pre-pipelineDeps).
 *
 * #1398: Connection and attachment lifetimes are tracked via monotonic
 * generations. Every subscription callback captures the generation at
 * subscription time and checks it before enqueuing frames. Central
 * teardown (detachAttachment / detachConnection) increments generations
 * BEFORE unsubscribing, so a synchronous callback during unsubscribe
 * cannot pass the current check. New-attach-wins is an atomic handoff:
 * old attachment/connection is detached before the replacement writer
 * is installed, leaving zero stale feed subscriptions.
 *
 * #1397: Stream-suppression ledger. Replaces the attachment-wide
 * `_hasStreamed` boolean with execution-scoped `StreamObservation`
 * tracking. Each stream start/delta/end event updates the ledger
 * keyed by (sessionId, executionId). Final delivery carries
 * DeliveryCorrelation; the ledger looks up the exact execution,
 * compares normalized visible streamed text with the whole result,
 * and suppresses only an exact match. Missing, stale, incomplete,
 * truncated, or mismatched executions always deliver the whole result.
 * State is consumed after every final decision so it cannot affect
 * another execution.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import { join, dirname } from "node:path";

import { logInfo, logDebug } from "../../components/logger.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";
import { abtarsHome } from "../../paths.js";
import type { PlatformAdapter, InboundMessage, PlatformCapabilities, SendOpts, DeliveryCorrelation } from "../../types/platform.js";
import type { Spin } from "../../components/spin.js";
import type { SessionType } from "../../components/spin-types.js";
import { typeLabel, sessionTypeOf } from "../../components/spin-types.js";
import { getMasterUserId } from "../../components/master-user.js";
import { queueInstruction, subscribeSteerEvents } from "../../components/session-instruction-queue.js";
import type { OrcActivityFeed } from "../../components/orc-activity-feed.js";
import type { SessionOutputFeed, SessionOutputEvent } from "../../components/session-output-feed.js";
import { buildOrcActivitySnapshot } from "../../components/orc-activity-snapshot.js";
import { buildTuiRuntimeStatus } from "./runtime-status.js";
import {
  encodeFrame,
  createFrameDecoder,
  isClientFrame,
  validateClientFrame,
  type TuiClientFrame,
  type TuiServerFrame,
  type TuiAttachMode,
  MAX_TUI_FRAME_BYTES,
} from "./tui-protocol.js";
import { TuiFrameWriter, type TuiFrameWriterResult } from "./tui-frame-writer.js";

const TAG = "tui";

// ── #1397: Stream-suppression ledger types ────────────────────────────────

interface StreamObservation {
  streamId: string;
  sequence: number;
  text: string;
  textBytes: number;
  ended: boolean;
  endReason?: string;
  truncated: boolean;
  errored: boolean;
}

interface ExecutionStreamObservation {
  sessionId: string;
  executionId: string;
  connGen: number;
  attGen: number;
  streams: Map<string, StreamObservation>;
  streamOrder: string[];
  totalBytes: number;
  hasVisibleText: boolean;
  anyTruncated: boolean;
  anyErrored: boolean;
  createdAt: number;
  updatedAt: number;
}

// #1397: Ledger bounds
const MAX_EXECUTION_OBSERVATIONS = 4;
const MAX_STREAMS_PER_EXECUTION = 20;
const MAX_COMPARISON_BYTES = 64 * 1024;   // 64 KiB accepted text cap
const COMPLETED_TTL_MS = 30_000;          // completed-undelivered cleanup

/** Normalize text for suppression comparison — CRLF→LF only. */
function normalizeComparison(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Build a ledger key from session + execution IDs.
 */
function execLedgerKey(sessionId: string, executionId: string): string {
  return `${sessionId}::${executionId}`;
}

export interface TuiAdapterDeps {
  spin: Spin;
  orcActivityFeed?: OrcActivityFeed;
  sessionOutputFeed?: SessionOutputFeed;
  onMessage: (msg: InboundMessage) => void;
  socketPath?: string;
}

export class TuiSocketAdapter implements PlatformAdapter {
  readonly name = "tui" as const;
  readonly capabilities: PlatformCapabilities = {
    voice: false,
    reactions: false,
    typing: true,
    threads: false,
  };
  readonly supportsStreaming = false;

  private server: net.Server | null = null;
  private conn: net.Socket | null = null;
  /** Current target session (set on attach). Cleared on detach. */
  private attachedSessionId: string | null = null;
  /** Pipeline = standard handleInboundMessage; orc = orc query with busy-guard. */
  private mode: "pipeline" | "orc" = "pipeline";
  private deps: TuiAdapterDeps;
  private readonly socketPath: string;
  /** True between `start()` and `stop()`. */
  private started = false;
  /** Activity subscription cleanup handle. */
  private _unsubActivity: (() => void) | null = null;
  /** Output subscription cleanup handle. */
  private _unsubOutput: (() => void) | null = null;
  /** Steer event subscription cleanup handle. */
  private _unsubSteer: (() => void) | null = null;
  /** #1397: Execution-scoped stream observation ledger (keyed by sessionId::executionId). */
  private _streamLedger = new Map<string, ExecutionStreamObservation>();
  /** Cached activity sequence for subscriber scoping. */
  private _activitySequence = 0;
  /** True while incremental activity is suppressed pending recovery. */
  private _activityDirty = false;
  /** Bounded per-connection frame writer (replaced on every new connection). */
  private _writer: TuiFrameWriter | null = null;
  /** Monotonic revision number for status frames (reset per attachment). */
  private _statusRevision = 0;

  // #1398: Connection and attachment generations — incremented on teardown.
  // Feed callbacks capture the value at subscription time and compare before
  // pushing; if stale they silently no-op.
  private _connGen = 1;
  private _attGen = 1;

  /** #1362: Attachment-scoped steering instruction ownership. Keyed by canonical server instruction ID. */
  private ownedSteer = new Map<string, { sessionId: string; executionId: string; connGen: number; attGen: number }>();

  constructor(deps: TuiAdapterDeps) {
    this.deps = deps;
    this.socketPath = deps.socketPath ?? join(abtarsHome(), "tui.sock");
  }

  /** Late-bind: replace onMessage callback after construction. */
  setMessageHandler(onMessage: (msg: InboundMessage) => void): void {
    this.deps.onMessage = onMessage;
  }

  /** Exposed for tests + boot diagnostics. */
  get isListening(): boolean { return this.server?.listening ?? false; }

  /** Exposed for tests. */
  get currentSocketPath(): string { return this.socketPath; }

  /** Exposed for tests — true if a client is currently attached. */
  get hasClient(): boolean { return this.conn !== null && !this.conn.destroyed; }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    const dir = dirname(this.socketPath);
    fs.mkdirSync(dir, { recursive: true });
    this._unlinkSocket();

    return new Promise<void>((resolve, reject) => {
      const server = net.createServer({ allowHalfOpen: false }, (conn) => this._onConnection(conn));
      server.on("error", (err) => reject(err));
      server.listen(this.socketPath, () => {
        try { fs.chmodSync(this.socketPath, 0o600); }
        catch (err) { logAndSwallow(TAG, "chmod socket", err); }
        this.server = server;
        this.started = true;
        logInfo(TAG, `Listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    const server = this.server;
    this.server = null;
    this.detachConnection();
    if (server) {
      try { server.close(); } catch { /* best effort */ }
    }
    this._unlinkSocket();
    logInfo(TAG, "Stopped");
  }

  // ── PlatformAdapter surface ──────────────────────────────────────────

  authorize(_msg: InboundMessage): boolean {
    return true;
  }

  async sendMessage(_channelId: string, text: string, _opts?: SendOpts): Promise<undefined> {
    // #1338/#1397: suppress whole result when the exact execution's
    // complete streamed text matches the delivered text.
    const correlation = _opts?.deliveryCorrelation;
    if (this.shouldSuppressWholeResult(text, correlation)) return;
    this._push({ t: "message", role: "assistant", markdown: text });
    this._pushStatus();
    return undefined;
  }

  // ── #1397: Suppression logic ───────────────────────────────────────────

  /**
   * Decide whether to suppress a whole assistant result because the same
   * execution already delivered equivalent complete streamed text.
   * The correlation entry is consumed (deleted) on every decision so it
   * cannot affect another execution.
   */
  private shouldSuppressWholeResult(text: string, correlation: DeliveryCorrelation | undefined): boolean {
    if (!correlation || correlation.kind !== "final_assistant") return false;
    if (correlation.sessionId !== this.attachedSessionId) return false;

    const key = execLedgerKey(correlation.sessionId, correlation.executionId);
    const obs = this._streamLedger.get(key);
    if (!obs) return false;

    // Stale generation — could be a reuse of the same session by another attach
    if (obs.connGen !== this._connGen || obs.attGen !== this._attGen) {
      this._streamLedger.delete(key);
      return false;
    }

    // Consume the entry after decision (both suppress and fallback)
    this._streamLedger.delete(key);

    // Must have visible text and no truncation/error
    if (!obs.hasVisibleText) return false;
    if (obs.anyTruncated || obs.anyErrored) return false;

    // All streams must have ended
    for (const stream of obs.streams.values()) {
      if (!stream.ended) return false;
    }

    // Normalized text comparison (CRLF→LF only)
    const streamedText = obs.streamOrder.map(id => obs.streams.get(id)!.text).join("");
    return normalizeComparison(streamedText) === normalizeComparison(text);
  }

  /** #1397: Record a stream start from the output feed. */
  private observeStreamStart(executionId: string, streamId: string): void {
    const key = execLedgerKey(this.attachedSessionId!, executionId);
    let obs = this._streamLedger.get(key);
    if (!obs) {
      // Bounded: drop oldest when at cap
      if (this._streamLedger.size >= MAX_EXECUTION_OBSERVATIONS) {
        const oldest = [...this._streamLedger.entries()]
          .sort(([, a], [, b]) => a.createdAt - b.createdAt)[0];
        if (oldest) this._streamLedger.delete(oldest[0]);
      }
      obs = {
        sessionId: this.attachedSessionId!,
        executionId,
        connGen: this._connGen,
        attGen: this._attGen,
        streams: new Map(),
        streamOrder: [],
        totalBytes: 0,
        hasVisibleText: false,
        anyTruncated: false,
        anyErrored: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this._streamLedger.set(key, obs);
    }

    if (obs.streamOrder.length >= MAX_STREAMS_PER_EXECUTION) return;

    if (!obs.streams.has(streamId)) {
      obs.streamOrder.push(streamId);
      obs.streams.set(streamId, {
        streamId,
        sequence: obs.streamOrder.length,
        text: "",
        textBytes: 0,
        ended: false,
        truncated: false,
        errored: false,
      });
      obs.updatedAt = Date.now();
    }
  }

  /** #1397: Record an accepted text delta. */
  private observeStreamDelta(executionId: string, streamId: string, delta: string, accepted: boolean): void {
    const key = execLedgerKey(this.attachedSessionId!, executionId);
    const obs = this._streamLedger.get(key);
    if (!obs) return;
    const stream = obs.streams.get(streamId);
    if (!stream || stream.ended) return;

    if (!accepted) {
      // Writer dropped the delta — stream is incomplete / truncated
      stream.truncated = true;
      obs.anyTruncated = true;
      obs.updatedAt = Date.now();
      return;
    }

    // Bounded comparison text
    if (obs.totalBytes < MAX_COMPARISON_BYTES) {
      const deltaBytes = Buffer.byteLength(delta, "utf8");
      if (obs.totalBytes + deltaBytes <= MAX_COMPARISON_BYTES) {
        stream.text += delta;
        stream.textBytes += deltaBytes;
        obs.totalBytes += deltaBytes;
      } else {
        // Partial append up to cap
        const remaining = MAX_COMPARISON_BYTES - obs.totalBytes;
        const partial = Buffer.from(delta, "utf8").slice(0, remaining).toString("utf8");
        stream.text += partial;
        stream.textBytes += Buffer.byteLength(partial, "utf8");
        obs.totalBytes = MAX_COMPARISON_BYTES;
      }
      obs.hasVisibleText = true;
    }
    obs.updatedAt = Date.now();
  }

  /** #1397: Record a stream end event. */
  private observeStreamEnd(executionId: string, streamId: string, reason: string): void {
    const key = execLedgerKey(this.attachedSessionId!, executionId);
    const obs = this._streamLedger.get(key);
    if (!obs) return;
    const stream = obs.streams.get(streamId);
    if (!stream) return;
    stream.ended = true;
    stream.endReason = reason;
    if (reason !== "complete") {
      if (reason === "error") {
        stream.errored = true;
        obs.anyErrored = true;
      } else if (reason === "truncated") {
        stream.truncated = true;
        obs.anyTruncated = true;
      } else if (reason === "cancelled") {
        stream.errored = true;
        obs.anyErrored = true;
      }
    }
    obs.updatedAt = Date.now();
  }

  /** #1397: Opportunistic cleanup of expired completed entries. */
  private pruneStreamLedger(): void {
    const cutoff = Date.now() - COMPLETED_TTL_MS;
    for (const [key, obs] of this._streamLedger) {
      const allEnded = [...obs.streams.values()].every(s => s.ended);
      if (allEnded && obs.updatedAt < cutoff) {
        this._streamLedger.delete(key);
      }
    }
  }

  chunkResponse(text: string): string[] {
    return [text];
  }

  // ── #1398: Generation guards ──────────────────────────────────────────

  /** True if the given connection generation is still current. */
  private _isConnCurrent(gen: number): boolean {
    return this._connGen === gen && this._writer !== null && !this._writer.isClosed;
  }

  /** True if both connection and attachment generations are still current. */
  private _isAttCurrent(connGen: number, attGen: number): boolean {
    return this._connGen === connGen && this._attGen === attGen;
  }

  // ── #1398: Centralized idempotent teardown ─────────────────────────────

  /**
   * Detach the current attachment. Invalidates the attachment generation
   * FIRST, then unsubscribes all three feeds and resets attachment-scoped
   * state. Idempotent — safe to call multiple times.
   */
  private detachAttachment(): void {
    this._attGen++;
    const ua = this._unsubActivity; this._unsubActivity = null;
    const uo = this._unsubOutput; this._unsubOutput = null;
    const us = this._unsubSteer; this._unsubSteer = null;
    try { ua?.(); } catch { /* best effort */ }
    try { uo?.(); } catch { /* best effort */ }
    try { us?.(); } catch { /* best effort */ }
    this._writer?.clearAttachment();
    this.ownedSteer.clear();
    this.attachedSessionId = null;
    this.mode = "pipeline";
    this._streamLedger.clear();
    this._activitySequence = 0;
    this._activityDirty = false;
    this._statusRevision = 0;
  }

  /**
   * Detach the current connection (including its attachment). Invalidates
   * both generations, closes the exact writer, and nullifies conn/writer
   * ownership. Does NOT close the socket itself (the caller owns the
   * socket lifetime).
   */
  private detachConnection(): void {
    this.detachAttachment();
    this._connGen++;
    this._writer?.close();
    this._writer = null;
    this.conn = null;
  }

  // ── Connection handling ──────────────────────────────────────────────

  private _onConnection(conn: net.Socket): void {
    // #1334/#1400: one bounded byte-oriented decoder per connection.
    // #1398: atomic handoff — capture old, detach BEFORE installing new.
    const oldConn = this.conn;
    this.detachConnection();

    // Send superseded error to the old socket directly (best-effort).
    if (oldConn && !oldConn.destroyed) {
      try {
        oldConn.write(encodeFrame({ t: "error", message: "detached: superseded by a new attach" }));
      } catch { /* best effort */ }
      try { oldConn.destroy(); } catch { /* best effort */ }
      logDebug(TAG, "Evicted previous client (new-attach-wins)");
    }

    // Install the new connection with a fresh generation.
    this.conn = conn;
    this._connGen++;
    this._attGen++;

    const connGen = this._connGen;

    const decode = createFrameDecoder<TuiClientFrame>({
      maxFrameBytes: MAX_TUI_FRAME_BYTES,
      onFatal: (error) => {
        // Only act if this exact connection and generation is still current.
        if (this.conn !== conn || this._connGen !== connGen) return;
        logDebug(TAG, `Fatal decode error: ${error.message}`);
        try { conn.write(encodeFrame({ t: "error", message: `protocol error: ${error.message}` })); } catch { /* best effort */ }
        conn.destroy();
      },
    });

    // #1339: bounded writer bound to this exact connection generation.
    const writer = new TuiFrameWriter(conn, {
      isCurrent: () => this._connGen === connGen && !conn.destroyed,
      onSemanticOverflow: () => {
        if (this._connGen === connGen) this._activityDirty = true;
      },
      onWritable: () => {
        if (this._connGen === connGen) this._recoverActivity();
      },
    });
    this._writer = writer;

    // Data handler with identity guard — passes raw bytes to bounded decoder.
    conn.on("data", (buf: Buffer) => {
      if (this.conn !== conn) return;
      if (decode.failed) return;
      const frames = decode.push(buf);
      for (const f of frames) {
        // #1400: validate client frame fields before dispatch
        if (!isClientFrame(f)) continue;
        const validation = validateClientFrame(f);
        if (!validation.ok) {
          logDebug(TAG, `Invalid client frame: ${validation.error}`);
          continue;
        }
        void this._handleFrame(f);
      }
    });
    conn.on("error", (err) => logAndSwallow(TAG, "conn error", err));

    // Close handler: detach only if this generation is still current.
    conn.on("close", () => {
      if (this._connGen === connGen) {
        this.detachConnection();
      }
    });
  }

  private async _handleFrame(frame: TuiClientFrame): Promise<void> {
    switch (frame.t) {
      case "attach":
        await this._handleAttach(frame.mode);
        return;
      case "input":
        await this._handleInput(frame.text);
        return;
      case "resize":
        return;
      case "steer":
        await this._handleSteer(frame);
        return;
    }
  }

  // ── Attach + commit attachment ───────────────────────────────────────

  /**
   * #1398: Unified commit helper. Detaches any current attachment (incrementing
   * _attGen), subscribes output/steer/activity feeds scoped to the new session
   * with captured generations, emits ready/status, and sends the activity
   * snapshot for orc mode. Used by _handleAttach, /session N, /session new.
   */
  private commitAttachment(
    sessionId: string,
    mode: "pipeline" | "orc",
    spin: Spin,
  ): void {
    // Detach the prior attachment first — invalidates old feed callbacks.
    this.detachAttachment();
    // Bump attGen so the new binding has a fresh value.
    this._attGen++;

    this.attachedSessionId = sessionId;
    this.mode = mode;
    this._statusRevision = 0;
    this._writer?.clearAttachment();

    const capturedConnGen = this._connGen;
    const capturedAttGen = this._attGen;

    // Subscribe output mirroring for the selected session.
    this._subscribeOutput(sessionId, capturedConnGen, capturedAttGen);

    // Subscribe steer lifecycle events.
    this._subscribeSteer(sessionId, capturedConnGen, capturedAttGen);

    // Emit ready + status.
    const type = sessionTypeOf(sessionId);
    const index = parseInt(sessionId.split("_")[2] ?? "0", 10);
    const label = `${typeLabel(type as SessionType)} #${index}`;
    this._push({ t: "ready", sessionLabel: label, sessionId });
    this._pushStatus();

    // #1319: Activity snapshot after ready.
    if (mode === "orc") {
      this._subscribeAndSnapshotOrc(sessionId, spin, capturedConnGen, capturedAttGen);
    }
  }

  /** Subscribe activity feed and send initial snapshot for orc mode. */
  private _subscribeAndSnapshotOrc(
    sessionId: string,
    spin: Spin,
    capturedConnGen: number,
    capturedAttGen: number,
  ): void {
    const feed = this.deps.orcActivityFeed;
    const orcEntry = spin.listAllSessions().find(
      s => s.id.includes("_O_") && s.status !== "ended",
    );
    if (!feed || !orcEntry) return;

    this._activitySequence = 0;
    const filter = {
      sessionId,
      executionId: orcEntry.activeExecutionId,
    };
    this._unsubActivity = feed.subscribe(filter, (event) => {
      if (!this._isAttCurrent(capturedConnGen, capturedAttGen)) return;
      if (event.sequence <= this._activitySequence) return;
      if (this._activityDirty) return;
      this._activitySequence = event.sequence;
      this._push({ t: "activity", sequence: event.sequence, event });
    }, () => {
      if (!this._isAttCurrent(capturedConnGen, capturedAttGen)) return;
      this._activityDirty = true;
      const recovered = this._recoverActivity(false);
      if (recovered) {
        queueMicrotask(() => { this._activityDirty = false; });
      }
    });

    // Send the initial snapshot.
    const orcSession = spin.getSessionById(sessionId);
    if (orcSession) {
      const snapshot = buildOrcActivitySnapshot(orcSession, spin.getSessions?.() ?? new Map(), this._activitySequence);
      this._push({ t: "activity-snapshot", sequence: this._activitySequence, snapshot });
    }
  }

  private async _handleAttach(mode: TuiAttachMode): Promise<void> {
    const capturedConnGen = this._connGen;

    const master = getMasterUserId();
    const spin = this.deps.spin;

    let sessionId: string;
    let nextMode: "pipeline" | "orc" = "pipeline";

    switch (mode.kind) {
      case "resume": {
        const candidates = spin.listAllSessions().filter(
          s => s.userId === master && s.id.includes("_A_") && s.status === "ready",
        );
        candidates.sort((a, b) => b.lastActiveAt - a.lastActiveAt || b.shortIndex - a.shortIndex);
        const existing = candidates[0];
        if (existing) {
          sessionId = existing.id;
        } else {
          const r = spin.createSession(master, "tui", "A" as SessionType);
          if (typeof r === "string") return this._reject(r);
          sessionId = r.id;
        }
        break;
      }
      case "session": {
        const target = spin.getSessionByGlobalIndex(mode.index);
        if (!target) return this._reject(`Session #${mode.index} not found.`);
        if (target.userId !== master) return this._reject(`Session #${mode.index} belongs to another user.`);
        if (target.status === "ended") return this._reject(`Session #${mode.index} is ended.`);
        sessionId = target.id;
        break;
      }
      case "new": {
        if (!["A", "B", "C"].includes(mode.sessionType)) {
          return this._reject(`Session type ${mode.sessionType} is not selectable from the terminal.`);
        }
        const r = spin.createSession(master, "tui", mode.sessionType as SessionType);
        if (typeof r === "string") return this._reject(r);
        sessionId = r.id;
        break;
      }
      case "orc": {
        if (!spin.getOrcSession()) return this._reject("No Orc session is running.");
        const orcEntry = spin.listAllSessions().find(
          s => s.id.includes("_O_") && s.status !== "ended",
        );
        if (!orcEntry) return this._reject("No Orc session is running.");
        sessionId = orcEntry.id;
        nextMode = "orc";
        break;
      }
    }

    // Guard: connection may have been replaced during setup.
    if (!this._isConnCurrent(capturedConnGen)) return;

    this.commitAttachment(sessionId, nextMode, spin);
  }

  private _pushStatus(): void {
    if (!this.attachedSessionId) return;
    const session = this.deps.spin.getSessionById(this.attachedSessionId);
    if (!session) return;
    this._statusRevision++;
    this._push({ t: "status", status: buildTuiRuntimeStatus(session, this._statusRevision) });
  }

  /**
   * #1339: semantic-activity overflow recovery, triggered by the writer's
   * `onWritable` (when a previously-blocked socket can accept frames again)
   * or by the feed's overflow callback.
   */
  private _recoverActivity(clearDirty = true): boolean {
    if (!this._writer || !this._activityDirty) return false;
    const feed = this.deps.orcActivityFeed;
    if (!feed) return false;
    const orcEntry = this.deps.spin.listAllSessions().find(
      s => s.id.includes("_O_") && s.status !== "ended",
    );
    if (!orcEntry) return false;

    this._writer.dropActivity();

    const seq = feed.currentSequence;
    const sessions = this.deps.spin.getSessions?.() ?? new Map();
    const snapshot = buildOrcActivitySnapshot(orcEntry, sessions, seq);
    const res = this._writer.enqueue({ t: "activity-snapshot", sequence: seq, snapshot });
    if (res === "dropped") {
      return false;
    }
    this._activitySequence = seq;
    if (clearDirty) this._activityDirty = false;
    return true;
  }

  /**
   * #1338: subscribe the current connection's writer to the live output feed
   * for exactly `sessionId`. Captures the current connection and attachment
   * generations so the callback silently no-ops after detach.
   */
  private _subscribeOutput(sessionId: string, capturedConnGen: number, capturedAttGen: number): void {
    if (this._unsubOutput) { this._unsubOutput(); this._unsubOutput = null; }
    const feed = this.deps.sessionOutputFeed;
    if (!feed) return;
    this._unsubOutput = feed.subscribe({ sessionId }, (event: SessionOutputEvent) => {
      if (!this._isAttCurrent(capturedConnGen, capturedAttGen)) return;

      // #1397: executionId is present on all event types
      const executionId = event.executionId;

      // Prune stale ledger entries opportunistically
      this.pruneStreamLedger();

      switch (event.type) {
        case "delta": {
          // Enqueue and check acceptance
          const result = this._push({ t: "chunk", id: event.streamId, delta: event.text });
          const accepted = result !== "dropped";
          if (executionId) {
            this.observeStreamStart(executionId, event.streamId);
            this.observeStreamDelta(executionId, event.streamId, event.text, accepted);
          }
          break;
        }
        case "tool-start":
          this._push({ t: "tool-start", id: event.streamId, name: event.name });
          break;
        case "end": {
          this._push({ t: "chunk-end", id: event.streamId, reason: event.reason });
          if (executionId) {
            this.observeStreamStart(executionId, event.streamId);
            this.observeStreamEnd(executionId, event.streamId, event.reason);
          }
          break;
        }
        case "start": {
          if (executionId) {
            this.observeStreamStart(executionId, event.streamId);
          }
          break;
        }
      }
    });
  }

  /** #1362: Subscribe to steer lifecycle events scoped to the attached session.
   *  Terminal acknowledgements are emitted only for instruction IDs owned by the
   *  current attachment, with exact session/execution identity match. Ownership
   *  is deleted after terminal delivery so duplicate events are idempotent. */
  private _subscribeSteer(sessionId: string, capturedConnGen: number, capturedAttGen: number): void {
    if (this._unsubSteer) { this._unsubSteer(); this._unsubSteer = null; }
    this._unsubSteer = subscribeSteerEvents({ sessionId }, (event) => {
      if (!this._isAttCurrent(capturedConnGen, capturedAttGen)) return;
      if (event.type === "steer.queued") return;

      const status: "consumed" | "rejected" | "expired" | "failed" | null =
        event.type === "steer.consumed" ? "consumed"
        : event.type === "steer.rejected" ? "rejected"
        : event.type === "steer.expired" ? "expired"
        : event.type === "steer.failed" ? "failed"
        : null;
      if (!status) return;

      for (const id of event.instructionIds) {
        const owner = this.ownedSteer.get(id);
        if (!owner) continue;
        if (owner.sessionId !== event.sessionId || owner.executionId !== event.executionId) continue;
        this._push({ t: "steer-ack", status, instructionId: id, message: event.description });
        this.ownedSteer.delete(id);
      }
    });
  }

  private async _handleInput(text: string): Promise<void> {
    if (!this.attachedSessionId) return;
    if (this.mode === "orc") {
      if (text.startsWith("/steer ")) {
        const body = text.slice("/steer ".length).trim();
        if (body) {
          // #1399: capture current attachment binding for the /steer text path
          await this._queueAndAck(body, this.attachedSessionId!, this._connGen, this._attGen, "");
          return;
        }
      }
      await this._routeToOrc(text);
      return;
    }

    // #1336: Local view commands before synthesizing an InboundMessage
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    // /session — list master's live sessions across platforms
    if (lower === "/session" || lower === "/sessions") {
      await this._listSessions();
      return;
    }

    // /session N — attach to global short index
    const sessionMatch = trimmed.match(/^\/session\s+(\d+)$/);
    if (sessionMatch) {
      const index = parseInt(sessionMatch[1]!, 10);
      await this._attachByGlobalIndex(index);
      return;
    }

    // /session new [type] — create a TUI-born selectable session and attach
    const newMatch = trimmed.match(/^\/session\s+new\s+(\w+)$/i);
    if (newMatch) {
      const st = newMatch[1]!.toUpperCase();
      if (!["A", "B", "C"].includes(st)) {
        this._push({ t: "message", role: "system", markdown: `Session type ${st} is not selectable from the terminal.` });
        return;
      }
      const spin = this.deps.spin;
      const master = getMasterUserId();
      const r = spin.createSession(master, "tui", st as SessionType);
      if (typeof r === "string") {
        this._push({ t: "message", role: "system", markdown: r });
        return;
      }
      // #1398: Use the unified commit helper.
      this.commitAttachment(r.id, "pipeline", spin);
      return;
    }

    // /session end|kill|pause|resume — reject with home-platform guidance
    const lifecycleMatch = trimmed.match(/^\/session\s+(end|kill|pause|resume)\b/i);
    if (lifecycleMatch) {
      const verb = lifecycleMatch[1]!.toLowerCase();
      this._push({ t: "message", role: "system", markdown: `Use /session ${verb} on the session's home platform (Telegram/Discord). TUI is a cross-platform view and cannot mutate session lifecycle.` });
      return;
    }

    const master = getMasterUserId();
    const msg: InboundMessage = {
      platform: "tui",
      channelId: "tui:local",
      userId: master,
      senderId: master,
      senderName: master,
      text,
      timestamp: Date.now(),
      isGroup: false,
      isVoice: false,
      targetSessionId: this.attachedSessionId,
    };
    this.deps.onMessage(msg);
  }

  /** #1336: Emit a list of the master's live sessions across platforms. */
  private async _listSessions(): Promise<void> {
    const master = getMasterUserId();
    const spin = this.deps.spin;
    const all = spin.listAllSessions().filter(
      s => s.userId === master && s.status !== "ended",
    );
    all.sort((a, b) => a.shortIndex - b.shortIndex);
    if (all.length === 0) {
      this._push({ t: "message", role: "system", markdown: "No live sessions." });
      return;
    }
    const lines = all.map(s => {
      const type = sessionTypeOf(s.id);
      const label = typeLabel(type as SessionType);
      const marker = s.id === this.attachedSessionId ? " ← attached" : "";
      return `#${s.shortIndex} ${label} (${s.platform}, ${s.status})${marker}`;
    });
    this._push({ t: "message", role: "system", markdown: lines.join("\n") });
  }

  /** #1336: Attach to a session by global shortIndex, emit ready. */
  private async _attachByGlobalIndex(index: number): Promise<void> {
    const master = getMasterUserId();
    const spin = this.deps.spin;
    const target = spin.getSessionByGlobalIndex(index);
    if (!target) {
      this._push({ t: "message", role: "system", markdown: `Session #${index} not found.` });
      return;
    }
    if (target.userId !== master) {
      this._push({ t: "message", role: "system", markdown: `Session #${index} belongs to another user.` });
      return;
    }
    if (target.status === "ended") {
      this._push({ t: "message", role: "system", markdown: `Session #${index} is ended.` });
      return;
    }
    // #1398: Use the unified commit helper.
    this.commitAttachment(target.id, "pipeline", spin);
  }

  /** #1361/#1399: Handle an explicit steer client frame. Requires exact non-empty sessionId match. */
  private async _handleSteer(frame: TuiClientFrame & { t: "steer" }): Promise<void> {
    // #1399: capture current attachment identity before any async boundary
    const capturedSessionId = this.attachedSessionId;
    const capturedConnGen = this._connGen;
    const capturedAttGen = this._attGen;
    if (!capturedSessionId) return;

    // #1399: exact non-empty sessionId comparison — no truthiness bypass
    if (frame.sessionId !== capturedSessionId) {
      this._push({ t: "steer-ack", status: "rejected", instructionId: frame.instructionId, message: "Steer session ID does not match the current attachment." });
      return;
    }
    await this._queueAndAck(frame.text, capturedSessionId, capturedConnGen, capturedAttGen, frame.instructionId);
  }

  /** #1332/#1399: Queue a steering instruction and push the acknowledgement frame. */
  private async _queueAndAck(text: string, capturedSessionId: string, capturedConnGen: number, capturedAttGen: number, clientInstructionId: string): Promise<void> {
    const spin = this.deps.spin;

    // #1399: recheck binding before mutating queue
    if (!this._isAttCurrent(capturedConnGen, capturedAttGen)) return;
    if (this.attachedSessionId !== capturedSessionId) return;

    const session = spin.getSessionById(capturedSessionId);
    if (!session) {
      this._push({ t: "steer-ack", status: "rejected", instructionId: clientInstructionId, message: "Session not found." });
      return;
    }

    const result = queueInstruction(session, { text, source: "tui" });
    if (result.ok) {
      this.ownedSteer.set(result.instruction.id, {
        sessionId: capturedSessionId,
        executionId: result.instruction.executionId,
        connGen: capturedConnGen,
        attGen: capturedAttGen,
      });
      this._push({ t: "steer-ack", status: "queued", instructionId: result.instruction.id, message: "Steering queued." });
    } else {
      const reasonMap: Record<string, string> = {
        not_found: "Session not found.",
        not_local: "Remote sessions cannot be steered.",
        not_active: "Session is ended or paused.",
        not_steerable: "Session is not accepting steering right now.",
        stale_execution: "Execution generation changed — steering rejected.",
        too_large: "Steering text too large (max 4 KiB).",
        queue_full: "Steering queue is full (max 20 items or 32 KiB).",
      };
      this._push({ t: "steer-ack", status: "rejected", instructionId: clientInstructionId, message: reasonMap[result.reason] ?? "Steering rejected." });
    }
  }

  private async _routeToOrc(text: string): Promise<void> {
    const spin = this.deps.spin;
    const capturedGen = this._connGen;

    if (!spin.getOrcSession()) {
      return void this._push({
        t: "message", role: "system",
        markdown: "Orc is not available (not running or still warming up).",
      });
    }
    const orcEntry = spin.listAllSessions().find(
      s => s.id.includes("_O_") && s.status !== "ended",
    );
    if (orcEntry?.busy) {
      return void this._push({
        t: "message", role: "system",
        markdown: `Orc is busy — use /steer <text> to queue a steering instruction, or wait until idle.\n\nExisting steering: try \`/steer ${text.slice(0, 80)}\` to queue this as a steering instruction.`,
      });
    }
    if (!orcEntry) {
      return void this._push({
        t: "message", role: "system",
        markdown: "Orc is not available (not running or still warming up).",
      });
    }
    try {
      const { result } = await spin.spin({
        type: "O",
        sessionId: orcEntry.id,
        prompt: `[USER] ${text}`,
        await: true,
      });
      // #1398: Guard against replacement during the async spin call.
      if (!this._isConnCurrent(capturedGen)) return;
      this._push({ t: "message", role: "assistant", markdown: result ?? "(no reply)" });
    } catch (err) {
      if (!this._isConnCurrent(capturedGen)) return;
      const message = err instanceof Error ? err.message : String(err);
      this._push({ t: "message", role: "system", markdown: `Orc error: ${message}` });
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  /** Send a server frame to the attached client via the current bounded writer. Returns the enqueue result. */
  private _push(frame: TuiServerFrame): TuiFrameWriterResult {
    if (!this._writer) return "dropped";
    return this._writer.enqueue(frame);
  }

  /** Reject an attach with a structured error frame, then drop the conn. */
  private _reject(message: string): void {
    const conn = this.conn;
    if (conn && !conn.destroyed) {
      try { conn.write(encodeFrame({ t: "error", message })); } catch { /* best effort */ }
    }
    this.detachConnection();
    if (conn) {
      try { conn.end(); } catch { /* best effort */ }
    }
  }

  private _unlinkSocket(): void {
    try {
      if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
    } catch (err) { logAndSwallow(TAG, "unlink socket", err); }
  }
}
