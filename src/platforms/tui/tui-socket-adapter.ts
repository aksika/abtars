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
import {
  encodeFrame,
  createFrameDecoder,
  isClientFrame,
  type TuiClientFrame,
  type TuiServerFrame,
  type TuiAttachMode,
} from "./tui-protocol.js";

const TAG = "tui";

export interface TuiAdapterDeps {
  spin: Spin;
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
  private readonly decoder = createFrameDecoder<TuiClientFrame>();
  /** True between `start()` and `stop()` — guards re-entrant close. */
  private started = false;

  constructor(deps: TuiAdapterDeps) {
    this.deps = deps;
    this.socketPath = deps.socketPath ?? join(abtarsHome(), "tui.sock");
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
    return undefined;
  }

  chunkResponse(text: string): string[] {
    // Terminal has no platform message-size limit; passthrough.
    return [text];
  }

  // ── Connection handling ──────────────────────────────────────────────

  private _onConnection(conn: net.Socket): void {
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
      const frames = this.decoder(buf.toString());
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
        this.conn = null;
        this.attachedSessionId = null;
        this.mode = "pipeline";
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
        // v1: ignore. The client reports cols/rows on attach; future
        // re-render could be wired here. For now, the terminal client
        // handles its own redraw on SIGWINCH.
        return;
    }
  }

  // ── Attach + input routing (filled in by Tasks 4 + 5) ───────────────

  private async _handleAttach(mode: TuiAttachMode): Promise<void> {
    const master = getMasterUserId();
    const spin = this.deps.spin;

    // Resume auto-creates a Main (A) session and returns its id directly
    // (string), not a session object. The other selectors return either
    // a ManagedSession or a string error code.
    let sessionId: string;
    let nextMode: "pipeline" | "orc" = "pipeline";

    switch (mode.kind) {
      case "resume":
        sessionId = spin.getActiveSessionId(master, "tui");
        break;
      case "session": {
        const r = spin.switchSession(master, "tui", mode.index);
        if (typeof r === "string") return this._reject(r);
        sessionId = r.id;
        break;
      }
      case "new": {
        // Defense in depth: client validates too, but the bridge is authoritative.
        // Reject internal/system types — only interactive A/B/C are user-selectable.
        if (!["A", "B", "C"].includes(mode.sessionType)) {
          return this._reject(`Session type ${mode.sessionType} is not selectable from the terminal.`);
        }
        const r = spin.createSession(master, "tui", mode.sessionType as SessionType);
        if (typeof r === "string") return this._reject(r);
        sessionId = r.id;
        break;
      }
      case "orc": {
        // The Orc is tracked both as an AgentSession (transport handle,
        // with isReady) and a ManagedSession (in the sessions Map, with
        // id + busy). getOrcSession() returns the AgentSession for the
        // ready check; we walk the sessions Map to find the ManagedSession
        // — same pattern as sendUserToOrc.
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

    this.attachedSessionId = sessionId;
    this.mode = nextMode;

    const type = sessionTypeOf(sessionId);
    const index = parseInt(sessionId.split("_")[2] ?? "0", 10);
    const label = `${typeLabel(type as SessionType)} #${index}`;
    this._push({ t: "ready", sessionLabel: label, sessionId });
  }

  private async _handleInput(text: string): Promise<void> {
    if (!this.attachedSessionId) {
      // No attach yet — input is a no-op. (The client shouldn't send input
      // before receiving ready. A post-ready re-attach that races a still-
      // open conn could land here; the close handler will clear it.)
      return;
    }
    if (this.mode === "orc") {
      await this._routeToOrc(text);
      return;
    }
    // Pipeline mode: synthesize an InboundMessage and hand to the standard
    // pipeline. handleInboundMessage resolves the active (master,"tui")
    // session (which attach just set) and runs the full path.
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
    };
    this.deps.onMessage(msg);
  }

  private async _routeToOrc(text: string): Promise<void> {
    const spin = this.deps.spin;
    // getOrcSession() returns null when Orc is absent OR not isReady
    // (warming/paused). We surface a distinct "not available" message
    // rather than the busy message.
    if (!spin.getOrcSession()) {
      return void this._push({
        t: "message",
        role: "system",
        markdown: "Orc is not available (not running or still warming up).",
      });
    }
    // Busy-guard: read the REAL per-session flag — ManagedSession.busy
    // (spin-types.ts:53), set true at message-pipeline.ts:222, cleared at
    // :93. Do NOT interrupt.
    const orcEntry = spin.listAllSessions().find(
      s => s.id.includes("_O_") && s.status !== "ended",
    );
    if (orcEntry?.busy) {
      return void this._push({
        t: "message",
        role: "system",
        markdown: "Orc is busy — try again when idle. (Live steering: #1319.)",
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

  /** Send a server frame to the attached client (best-effort). */
  private _push(frame: TuiServerFrame): void {
    const conn = this.conn;
    if (!conn || conn.destroyed) return;
    try { conn.write(encodeFrame(frame)); }
    catch (err) { logAndSwallow(TAG, "socket write", err); }
  }

  /** Reject an attach with a structured error frame, then drop the conn. */
  private _reject(message: string): void {
    this._push({ t: "error", message });
    // Pre-`ready` errors are fatal on the client side (exit 1). Drop the
    // socket so the client sees `close` immediately after the error frame.
    const conn = this.conn;
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
