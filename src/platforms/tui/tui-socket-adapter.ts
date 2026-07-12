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
 *   - We do NOT import the browser class — it dispatches BrowserAction and
 *     would couple the two systems.
 *
 * Single-client: one live connection at a time. New-attach-wins: a new
 * connection sends `error` to the existing client and evicts it. The
 * evicted client treats the post-`ready` error as a clean detach.
 *
 * Recovery-handler pattern: onMessage is set at construction to the
 * recovery handler. wireTui() swaps in handleInboundMessage after
 * pipelineDeps is ready. We never call handleInboundMessage at
 * construction (would crash pre-pipelineDeps).
 */

import * as fs from "node:fs";
import * as net from "node:net";
import { join, dirname } from "node:path";

import { logInfo, logDebug } from "../../components/logger.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";
import { abtarsHome } from "../../paths.js";
import type { PlatformAdapter, InboundMessage, PlatformCapabilities, SendOpts } from "../../types/platform.js";
import type { Spin } from "../../components/spin.js";
import type { SessionType } from "../../components/spin-types.js";
import { typeLabel, sessionTypeOf } from "../../components/spin-types.js";
import { getMasterUserId } from "../../components/master-user.js";
import { queueInstruction, onSteerEvent } from "../../components/session-instruction-queue.js";
import type { OrcActivityFeed } from "../../components/orc-activity-feed.js";
import { buildOrcActivitySnapshot } from "../../components/orc-activity-snapshot.js";
import { buildTuiRuntimeStatus } from "./runtime-status.js";
import {
  encodeFrame,
  createFrameDecoder,
  isClientFrame,
  type TuiClientFrame,
  type TuiServerFrame,
  type TuiAttachMode,
} from "./tui-protocol.js";
import { TuiFrameWriter } from "./tui-frame-writer.js";

const TAG = "tui";

export interface TuiAdapterDeps {
  spin: Spin;
  /** #1319: Activity feed for Orc execution events. */
  orcActivityFeed?: OrcActivityFeed;
  /** Set to the recovery handler at construction; swapped to handleInboundMessage by wireTui. */
  onMessage: (msg: InboundMessage) => void;
  /** Override the default socket path (~/.abtars/tui.sock). */
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
  // v1: whole-message frames only. Per-delta streaming is reserved for #1319
  // — the pipeline's onIntermediateResponse hook is transport-level, not
  // adapter-level (see message-pipeline.ts:410, cleared post-response).
  readonly supportsStreaming = false;

  private server: net.Server | null = null;
  private conn: net.Socket | null = null;
  /** Current target session (set on attach). Cleared on detach. */
  private attachedSessionId: string | null = null;
  /** Pipeline = standard handleInboundMessage; orc = orc query with busy-guard. */
  private mode: "pipeline" | "orc" = "pipeline";
  private deps: TuiAdapterDeps;
  private readonly socketPath: string;
  /** True between `start()` and `stop()` — guards re-entrant close. */
  private started = false;
  /** #1319: Activity subscription cleanup, set on orc attach, cleared on detach. */
  private _unsubActivity: (() => void) | null = null;
  /** #1319: Cached activity sequence for subscriber scoping. */
  private _activitySequence = 0;
  /** #1339: True while incremental activity is suppressed pending recovery. */
  private _activityDirty = false;
  /** #1339: Bounded per-connection frame writer (replaced on every new attach). */
  private _writer: TuiFrameWriter | null = null;
  /** Monotonic status revision for the current socket/attachment. */
  private _statusRevision = 0;

  constructor(deps: TuiAdapterDeps) {
    this.deps = deps;
    this.socketPath = deps.socketPath ?? join(abtarsHome(), "tui.sock");
    // #1332: Subscribe to async steer lifecycle events to push ack frames
    onSteerEvent((event) => {
      const status = event.type === "steer.queued" ? "queued" as const
        : event.type === "steer.consumed" ? "consumed" as const
        : event.type === "steer.rejected" ? "rejected" as const
        : event.type === "steer.expired" ? "expired" as const
        : event.type === "steer.failed" ? "failed" as const
        : null;
      if (!status || status === "queued") return;
      const id = event.instructionIds[0] ?? "";
      this._push({ t: "steer-ack", status, instructionId: id, message: event.description });
    });
  }

  /** Late-bind: replace onMessage callback after construction. Mirrors IrcAdapter. */
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
        // Explicit 0600 — see header comment. We do this AFTER listen so
        // a race-y chmod of a non-existent path can't happen.
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
    if (this._unsubActivity) { this._unsubActivity(); this._unsubActivity = null; }
    // #1339: invalidate the writer and remove its listeners.
    this._writer?.close();
    this._writer = null;
    if (this.conn) {
      try { this.conn.destroy(); } catch { /* best effort */ }
      this.conn = null;
    }
    if (this.server) {
      try { this.server.close(); } catch { /* best effort */ }
      this.server = null;
    }
    this._unlinkSocket();
    this.attachedSessionId = null;
    this.mode = "pipeline";
    logInfo(TAG, "Stopped");
  }

  // ── PlatformAdapter surface ──────────────────────────────────────────

  authorize(_msg: InboundMessage): boolean {
    // Authorization is enforced at attach time (master-only via getMasterUserId).
    return true;
  }

  async sendMessage(_channelId: string, text: string, _opts?: SendOpts): Promise<undefined> {
    this._push({ t: "message", role: "assistant", markdown: text });
    this._pushStatus();
    return undefined;
  }

  chunkResponse(text: string): string[] {
    // Terminal has no platform message-size limit; passthrough.
    return [text];
  }

  // ── Connection handling ──────────────────────────────────────────────

  private _onConnection(conn: net.Socket): void {
    // #1334: one decoder per connection. A stateful frame decoder buffers
    // a trailing partial JSONL line. Adapter-scoped, that buffer was
    // shared across every connection's bytes — so when new-attach-wins
    // evicted the old client, the old client's leftover bytes combined
    // with the new client's first frame and dropped it (malformed JSON).
    // Per-connection, the buffer dies with its socket.
    const decode = createFrameDecoder<TuiClientFrame>();

    // New-attach-wins: send a "superseded" error to the existing client and
    // destroy it. We write directly to `old` — not via this._push, which now
    // targets the new conn. The evicted client sees post-`ready` error →
    // exit 0, NOT a startup failure.
    const old = this.conn;
    this.conn = conn;
    this.attachedSessionId = null;
    this.mode = "pipeline";

    if (old && !old.destroyed) {
      try {
        old.write(encodeFrame({ t: "error", message: "detached: superseded by a new attach" }));
      } catch { /* best effort */ }
      try { old.destroy(); } catch { /* best effort */ }
      logDebug(TAG, "Evicted previous client (new-attach-wins)");
    }

    conn.on("data", (buf: Buffer) => {
      // Identity guard: a superseded socket may still deliver a final
      // data event after new-attach-wins replaced `this.conn`. Drop any
      // bytes that don't belong to the current connection so a late
      // complete frame from the evicted client cannot act on the new
      // attachment.
      if (this.conn !== conn) return;
      const frames = decode(buf.toString());
      for (const f of frames) {
        if (isClientFrame(f)) {
          // Best-effort: handler errors are logged via logAndSwallow where
          // they originate; we never let one crash the connection.
          void this._handleFrame(f);
        }
      }
    });
    conn.on("error", (err) => logAndSwallow(TAG, "conn error", err));
    conn.on("close", () => {
      if (this.conn === conn) {
        // #1339: close the exact writer bound to this socket so a stale
        // drain/close from a superseded connection cannot leak frames.
        this._writer?.close();
        this._writer = null;
        this.conn = null;
        this.attachedSessionId = null;
        this.mode = "pipeline";
        if (this._unsubActivity) { this._unsubActivity(); this._unsubActivity = null; }
      }
    });

    // #1339: create a fresh bounded writer for this exact connection. The
    // captured `writer` identity plus `isCurrent()` guarantees a superseded
    // connection's drain/close events cannot flush into this one.
    this._writer?.close();
    const writer = new TuiFrameWriter(conn, {
      isCurrent: () => this._writer === writer && this.conn === conn && !conn.destroyed,
      onSemanticOverflow: () => { this._activityDirty = true; },
      onWritable: () => this._recoverActivity(),
    });
    this._writer = writer;
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
        // v1: ignore. The client reports cols/rows on attach; future
        // re-render could be wired here. For now, the terminal client
        // handles its own redraw on SIGWINCH.
        return;
      case "steer":
        await this._handleSteer(frame);
        return;
    }
  }

  // ── Attach + input routing (filled in by Tasks 4 + 5) ───────────────

  private async _handleAttach(mode: TuiAttachMode): Promise<void> {
    // Clean up any previous activity subscription
    if (this._unsubActivity) { this._unsubActivity(); this._unsubActivity = null; }
    // #1339: reset semantic-recovery state and clear attachment-scoped queued
    // frames (status/activity/snapshot/typing) for the new attachment.
    this._activityDirty = false;
    this._writer?.clearAttachment();

    const master = getMasterUserId();
    const spin = this.deps.spin;

    let sessionId: string;
    let nextMode: "pipeline" | "orc" = "pipeline";

    switch (mode.kind) {
      case "resume": {
        // #1336: Default to the master's newest ready Main across all platforms.
        // Sort by lastActiveAt desc, shortIndex desc as tie-breaker.
        const candidates = spin.listAllSessions().filter(
          s => s.userId === master && s.id.includes("_A_") && s.status === "ready",
        );
        candidates.sort((a, b) => b.lastActiveAt - a.lastActiveAt || b.shortIndex - a.shortIndex);
        const existing = candidates[0];
        if (existing) {
          sessionId = existing.id;
        } else {
          // No ready Main anywhere — create a TUI-born one
          const r = spin.createSession(master, "tui", "A" as SessionType);
          if (typeof r === "string") return this._reject(r);
          sessionId = r.id;
        }
        break;
      }
      case "session": {
        // #1336: global-index lookup — does not call switchSession()
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

        // #1319: Subscribe to activity feed before snapshot to close the race
        const feed = this.deps.orcActivityFeed;
        if (feed) {
          this._activitySequence = 0;
          const filter = {
            sessionId,
            executionId: orcEntry.activeExecutionId,
          };
          this._unsubActivity = feed.subscribe(filter, (event) => {
            if (event.sequence <= this._activitySequence) return;
            // #1339: suppress incremental activity while awaiting recovery.
            if (this._activityDirty) return;
            this._activitySequence = event.sequence;
            this._push({ t: "activity", event });
          }, () => {
            // #1339: feed-side overflow → mark dirty, discard the pending
            // incremental batch, and attempt recovery now. The writer flushes
            // the snapshot when writable; if blocked, onWritable retries after
            // the next drain. Dirty is cleared only after the feed's pending
            // microtask batch is consumed, so stale increments stay suppressed
            // and the fresh snapshot stays first.
            this._activityDirty = true;
            const recovered = this._recoverActivity(false);
            if (recovered) {
              queueMicrotask(() => { this._activityDirty = false; });
            }
          });
        }
        break;
      }
    }

    this.attachedSessionId = sessionId;
    this.mode = nextMode;
    this._statusRevision = 0;

    const type = sessionTypeOf(sessionId);
    const index = parseInt(sessionId.split("_")[2] ?? "0", 10);
    const label = `${typeLabel(type as SessionType)} #${index}`;
    this._push({ t: "ready", sessionLabel: label, sessionId });
    this._pushStatus();

    // #1319: Send activity snapshot after ready
    if (nextMode === "orc" && this.deps.orcActivityFeed) {
      const orcSession = spin.getSessionById(sessionId);
      if (orcSession) {
        const snapshot = buildOrcActivitySnapshot(orcSession, this.deps.spin.getSessions?.() ?? new Map(), this._activitySequence);
        this._push({ t: "activity-snapshot", sequence: this._activitySequence, snapshot });
      }
    }
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
   *
   * Verifies socket/attachment identity (guaranteed by the writer's
   * `isCurrent()`), drops queued incremental activity, and enqueues a fresh
   * authoritative snapshot before subsequent incremental activity resumes.
   * If the recovery snapshot itself cannot be queued, stays dirty (the writer
   * coalesces to the newest snapshot) and the caller retries on the next
   * writable. When `clearDirty` is true the dirty flag is cleared on success
   * (drain path); the feed-overflow path clears it after its pending batch.
   *
   * @returns true if recovery succeeded and dirty was (or will be) cleared.
   */
  private _recoverActivity(clearDirty = true): boolean {
    if (!this._writer || !this._activityDirty) return false;
    const feed = this.deps.orcActivityFeed;
    if (!feed) return false;
    const orcEntry = this.deps.spin.listAllSessions().find(
      s => s.id.includes("_O_") && s.status !== "ended",
    );
    if (!orcEntry) return false;

    // Discard queued incremental activity for this attachment.
    this._writer.dropActivity();

    // Build a fresh authoritative snapshot from the feed's current sequence.
    const seq = feed.currentSequence;
    const sessions = this.deps.spin.getSessions?.() ?? new Map();
    const snapshot = buildOrcActivitySnapshot(orcEntry, sessions, seq);
    const res = this._writer.enqueue({ t: "activity-snapshot", sequence: seq, snapshot });
    if (res === "dropped") {
      // Recovery itself pressured → remain dirty; newest snapshot wins on retry.
      return false;
    }
    this._activitySequence = seq;
    if (clearDirty) this._activityDirty = false;
    return true;
  }

  private async _handleInput(text: string): Promise<void> {
    if (!this.attachedSessionId) {
      return;
    }
    if (this.mode === "orc") {
      if (text.startsWith("/steer ")) {
        const body = text.slice("/steer ".length).trim();
        if (body) {
          await this._queueAndAck(body);
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
      this.attachedSessionId = r.id;
      const type = sessionTypeOf(r.id);
      const index2 = parseInt(r.id.split("_")[2] ?? "0", 10);
      const label = `${typeLabel(type as SessionType)} #${index2}`;
      this._push({ t: "ready", sessionLabel: label, sessionId: r.id });
      this._pushStatus();
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
      // #1336: carry the attached session as the routing target
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
    this.attachedSessionId = target.id;
    this._statusRevision = 0;
    const type = sessionTypeOf(target.id);
    const idx = parseInt(target.id.split("_")[2] ?? "0", 10);
    const label = `${typeLabel(type as SessionType)} #${idx}`;
    this._push({ t: "ready", sessionLabel: label, sessionId: target.id });
    this._pushStatus();
  }

  /** #1332: Handle an explicit steer client frame. Validates and queues. */
  private async _handleSteer(frame: TuiClientFrame & { t: "steer" }): Promise<void> {
    if (!this.attachedSessionId) return;
    if (this.mode !== "orc") {
      this._push({ t: "steer-ack", status: "rejected", instructionId: frame.instructionId, message: "Steer is only available in Orc mode." });
      return;
    }
    await this._queueAndAck(frame.text);
  }

  /** #1332: Queue a steering instruction and push the acknowledgement frame. */
  private async _queueAndAck(text: string): Promise<void> {
    const spin = this.deps.spin;
    if (!this.attachedSessionId) return;

    const session = spin.getSessionById(this.attachedSessionId);
    if (!session) {
      this._push({ t: "steer-ack", status: "rejected", instructionId: "", message: "Session not found." });
      return;
    }

    const result = queueInstruction(session, { text, source: "tui" });
    if (result.ok) {
      this._push({ t: "steer-ack", status: "queued", instructionId: result.instruction.id, message: "Steering queued." });
    } else {
      const reasonMap: Record<string, string> = {
        not_found: "Session not found.",
        not_orc: "Steering is only available for the Orc session.",
        not_busy: "Orc is not busy — use plain text to send a query.",
        stale_execution: "Orc execution has changed — steering rejected.",
        too_large: "Steering text too large (max 4 KiB).",
        queue_full: "Steering queue is full (max 20 items or 32 KiB).",
      };
      this._push({ t: "steer-ack", status: "rejected", instructionId: "", message: reasonMap[result.reason] ?? "Steering rejected." });
    }
  }

  private async _routeToOrc(text: string): Promise<void> {
    const spin = this.deps.spin;
    if (!spin.getOrcSession()) {
      return void this._push({
        t: "message",
        role: "system",
        markdown: "Orc is not available (not running or still warming up).",
      });
    }
    const orcEntry = spin.listAllSessions().find(
      s => s.id.includes("_O_") && s.status !== "ended",
    );
    // #1332: When busy, suggest /steer instead of rejecting
    if (orcEntry?.busy) {
      return void this._push({
        t: "message",
        role: "system",
        markdown: `Orc is busy — use /steer <text> to queue a steering instruction, or wait until idle.\n\nExisting steering: try \`/steer ${text.slice(0, 80)}\` to queue this as a steering instruction.`,
      });
    }
    if (!orcEntry) {
      return void this._push({
        t: "message",
        role: "system",
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
      this._push({ t: "message", role: "assistant", markdown: result ?? "(no reply)" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._push({ t: "message", role: "system", markdown: `Orc error: ${message}` });
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  /** Send a server frame to the attached client via the current bounded writer. */
  private _push(frame: TuiServerFrame): void {
    if (!this._writer) return;
    this._writer.enqueue(frame);
  }

  /** Reject an attach with a structured error frame, then drop the conn. */
  private _reject(message: string): void {
    const conn = this.conn;
    // Direct best-effort write (pre-ready terminal path); do not route through
    // the writer's queue which we are about to invalidate.
    if (conn && !conn.destroyed) {
      try { conn.write(encodeFrame({ t: "error", message })); } catch { /* best effort */ }
    }
    // #1339: invalidate the writer so no further frames target this socket.
    this._writer?.close();
    this._writer = null;
    this.conn = null;
    this.attachedSessionId = null;
    this.mode = "pipeline";
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
