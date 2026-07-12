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
 *
 * #1398: Connection and attachment lifetimes are tracked via monotonic
 * generations. Every subscription callback captures the generation at
 * subscription time and checks it before enqueuing frames. Central
 * teardown (detachAttachment / detachConnection) increments generations
 * BEFORE unsubscribing, so a synchronous callback during unsubscribe
 * cannot pass the current check. New-attach-wins is an atomic handoff:
 * old attachment/connection is detached before the replacement writer
 * is installed, leaving zero stale feed subscriptions.
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
import { queueInstruction, subscribeSteerEvents } from "../../components/session-instruction-queue.js";
import type { OrcActivityFeed } from "../../components/orc-activity-feed.js";
import type { SessionOutputFeed, SessionOutputEvent } from "../../components/session-output-feed.js";
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
  /** True once live chunks were mirrored for the current attachment. */
  private _hasStreamed = false;
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
    // #1338: suppress duplicate whole-result if already streamed.
    if (!this._hasStreamed) {
      this._push({ t: "message", role: "assistant", markdown: text });
    }
    this._pushStatus();
    return undefined;
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
    this.attachedSessionId = null;
    this.mode = "pipeline";
    this._hasStreamed = false;
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
    // #1334: one decoder per connection.
    const decode = createFrameDecoder<TuiClientFrame>();

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

    // Data handler with identity guard.
    conn.on("data", (buf: Buffer) => {
      if (this.conn !== conn) return;
      const frames = decode(buf.toString());
      for (const f of frames) {
        if (isClientFrame(f)) {
          void this._handleFrame(f);
        }
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
      this._push({ t: "activity", event });
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
    this._hasStreamed = false;
    const feed = this.deps.sessionOutputFeed;
    if (!feed) return;
    this._unsubOutput = feed.subscribe({ sessionId }, (event: SessionOutputEvent) => {
      if (!this._isAttCurrent(capturedConnGen, capturedAttGen)) return;
      switch (event.type) {
        case "delta":
          this._hasStreamed = true;
          this._push({ t: "chunk", id: event.streamId, delta: event.text });
          break;
        case "tool-start":
          this._push({ t: "tool-start", id: event.streamId, name: event.name });
          break;
        case "end":
          this._push({ t: "chunk-end", id: event.streamId, reason: event.reason });
          break;
        case "start":
          break;
      }
    });
  }

  /** #1362: Subscribe to steer lifecycle events scoped to the attached session. */
  private _subscribeSteer(sessionId: string, capturedConnGen: number, capturedAttGen: number): void {
    if (this._unsubSteer) { this._unsubSteer(); this._unsubSteer = null; }
    this._unsubSteer = subscribeSteerEvents({ sessionId }, (event) => {
      if (!this._isAttCurrent(capturedConnGen, capturedAttGen)) return;
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

  private async _handleInput(text: string): Promise<void> {
    if (!this.attachedSessionId) return;
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

  /** #1361: Handle an explicit steer client frame from any attached session. */
  private async _handleSteer(frame: TuiClientFrame & { t: "steer" }): Promise<void> {
    if (!this.attachedSessionId) return;
    if (frame.sessionId && frame.sessionId !== this.attachedSessionId) {
      this._push({ t: "steer-ack", status: "rejected", instructionId: frame.instructionId, message: "Steer session ID does not match the current attachment." });
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
        not_local: "Remote sessions cannot be steered.",
        not_active: "Session is ended or paused.",
        not_steerable: "Session is not accepting steering right now.",
        stale_execution: "Execution generation changed — steering rejected.",
        too_large: "Steering text too large (max 4 KiB).",
        queue_full: "Steering queue is full (max 20 items or 32 KiB).",
      };
      this._push({ t: "steer-ack", status: "rejected", instructionId: "", message: reasonMap[result.reason] ?? "Steering rejected." });
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

  /** Send a server frame to the attached client via the current bounded writer. */
  private _push(frame: TuiServerFrame): void {
    if (!this._writer) return;
    this._writer.enqueue(frame);
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
