/**
 * tui-client.ts — #1528 TUI acceptance client. Speaks the production
 * TuiSocketAdapter wire protocol over the unix socket and asserts on
 * TUI-visible frames only — never transport internals.
 */

import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { createFrameDecoder, type TuiServerFrame, type TuiClientFrame } from "../../../platforms/tui/tui-protocol.js";
import { TIMEOUTS } from "./contracts.js";
import { waitFor } from "./child-process.js";

export interface TuiMessage {
  role: "assistant" | "system";
  markdown: string;
}

export class TuiAcceptanceClient {
  private socket: Socket | null = null;
  private decoder = createFrameDecoder<TuiServerFrame>();
  private frameQueue: TuiServerFrame[] = [];
  private waiters: Array<(frame: TuiServerFrame) => void> = [];
  private attachedSessionId: string | null = null;
  private _lastError: string | null = null;
  private readonly socketPath: string;

  constructor(abtarsHome: string) {
    this.socketPath = join(abtarsHome, "tui.sock");
  }

  get sessionId(): string | null {
    return this.attachedSessionId;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  async connect(mode: "new" | "resume" = "new"): Promise<void> {
    const deadline = Date.now() + TIMEOUTS.bridgeReadinessMs;
    // The bridge re-creates its socket on restart; retry through the
    // ECONNREFUSED window rather than failing on a stale socket file.
    while (Date.now() < deadline) {
      try {
        await this.tryConnect(mode);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/ECONNREFUSED|ENOENT|connect/i.test(message)) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`TUI connect timed out after ${TIMEOUTS.bridgeReadinessMs}ms (last error: ${this.lastError ?? "none"})`);
  }

  private async tryConnect(mode: "new" | "resume"): Promise<void> {
    this.socket = createConnection(this.socketPath);
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.socket!.once("error", onError);
      this.socket!.once("connect", () => {
        this.socket!.removeListener("error", onError);
        resolve();
      });
    });
    this.decoder = createFrameDecoder<TuiServerFrame>();
    this.frameQueue = [];
    this.socket.on("data", (chunk: Buffer) => {
      if (process.env["PI_E2E_DEBUG_RAW"] === "1") console.error(`[raw] ${JSON.stringify(chunk.toString("utf-8").slice(0, 300))}`);
      const frames = this.decoder.push(chunk);
      if (process.env["PI_E2E_DEBUG_RAW"] === "1") {
        console.error(`[decode] chunk=${chunk.length}B frames=${frames.length} failed=${this.decoder.failed} buffered=${this.decoder.bufferedBytes}`);
      }
      for (const frame of frames) {
        this.route(frame);
      }
    });
    this.socket.on("error", (err) => {
      this._lastError = err.message;
    });

    this.send({
      t: "attach",
      mode: mode === "new" ? { kind: "new", sessionType: "A" } : { kind: "resume" },
      cols: 100,
      rows: 30,
    });

    const ready = await waitFor(
      async () => {
        const frame = this.nextFrame((f) => f.t === "ready" || f.t === "error");
        if (!frame) return undefined;
        if (frame.t === "error") throw new Error(`TUI attach rejected: ${frame.message}`);
        return frame as Extract<TuiServerFrame, { t: "ready" }>;
      },
      TIMEOUTS.bridgeReadinessMs,
      "TUI ready frame",
      () => `last TUI error: ${this.lastError ?? "none"}`,
    );
    this.attachedSessionId = ready.sessionId;
  }

  private receivedFrames: string[] = [];

  /** Send one inbound user message or command without awaiting a reply. */
  sendInput(text: string): void {
    if (!this.socket) throw new Error("TUI client not connected");
    this.send({ t: "input", text });
  }

  /** Send one inbound user message or command; await the bounded final reply. */
  async sendAndAwaitReply(text: string, timeoutMs: number = TIMEOUTS.turnMs): Promise<TuiMessage> {
    if (!this.socket) throw new Error("TUI client not connected");
    this.send({ t: "input", text });
    return this.awaitMessage(timeoutMs).catch((err) => {
      throw new Error(`${(err as Error).message}\n[recv] ${this.receivedFrames.slice(-8).join(" | ")}`);
    });
  }

  /** Await the next assistant/system message frame, bounded. */
  async awaitMessage(timeoutMs: number): Promise<TuiMessage> {
    // The bridge streams deltas as chunk frames and (via the #1397
    // suppression ledger) may suppress the whole-result message frame when
    // the streamed text matches exactly. A stream completion therefore needs
    // a short settle window to prefer an eventual message frame (tool rounds
    // deliver one; plain turns usually do not).
    //
    // #1612: stream-start/tool-start progress frames are presentation-only;
    // they are consumed here so they cannot accumulate in the frame queue.
    let streamText = "";
    const result = await waitFor<TuiMessage>(
      async () => {
        const frame = this.nextFrame(
          (x) => x.t === "message" || x.t === "chunk" || x.t === "chunk-end"
            || x.t === "stream-start" || x.t === "error",
        );
        if (process.env["PI_E2E_DEBUG_FRAMES"] === "1") {
          console.error(`[awaitMessage] queue=${this.frameQueue.length} frame=${frame ? JSON.stringify(frame).slice(0, 120) : "none"}`);
        }
        if (!frame) return undefined;
        switch (frame.t) {
          case "stream-start":
            return undefined;
          case "message":
            // The pipeline emits transient tool-status messages ("🔧 ...")
            // before the final answer; they are not the reply.
            if (frame.markdown.trimStart().startsWith("🔧 ")) return undefined;
            if (process.env["PI_E2E_DEBUG_FRAMES"] === "1") console.error(`[awaitMessage] RETURNING message frame`);
            return { role: frame.role, markdown: frame.markdown };
          case "error":
            throw new Error(`TUI error frame: ${frame.message}`);
          case "chunk":
            streamText += frame.delta;
            return undefined;
          case "chunk-end": {
            // Steering aborts intermediate generations by design — a
            // "cancelled" end is expected mid-turn and is not a failure of
            // the awaited final reply. Real stream errors still fail.
            if (frame.reason === "error") {
              throw new Error(`TUI stream ended with reason ${frame.reason}`);
            }
            if (frame.reason === "truncated") {
              throw new Error("TUI stream truncated");
            }
            if (frame.reason !== "complete" || streamText.trim() === "") {
              if (process.env["PI_E2E_DEBUG_SETTLE"] === "1") console.error(`[probe] chunk-end skip reason=${frame.reason} text=${streamText.length}B`);
              return undefined;
            }
            const accumulated = streamText;
            if (process.env["PI_E2E_DEBUG_SETTLE"] === "1") console.error(`[probe] chunk-end COMPLETE text=${accumulated.length}B -> settle`);
            const settle = await this.settleForMessage(250);
            return settle ?? { role: "assistant", markdown: accumulated };
          }
        }
        return undefined;
      },
      timeoutMs,
      "TUI assistant message",
      () => `last TUI error: ${this.lastError ?? "none"}`,
    );
    return result;
  }

  /** Wait a short bounded window for a whole message frame to arrive. */
  private settleForMessage(ms: number): Promise<TuiMessage | undefined> {
    if (process.env["PI_E2E_DEBUG_SETTLE"] === "1") console.error(`[settle] ATTACH`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.socket?.off("data", onData);
        const consumed = this.nextFrame((f) => f.t === "message") as Extract<TuiServerFrame, { t: "message" }> | undefined;
        if (process.env["PI_E2E_DEBUG_SETTLE"] === "1") console.error(`[settle] TIMER consumed=${consumed ? "yes" : "no"}`);
        resolve(consumed);
      }, ms);
      const onData = () => {
        const frame = this.nextFrame((f) => f.t === "message" || f.t === "error");
        if (frame) {
          clearTimeout(timer);
          this.socket?.off("data", onData);
          if (process.env["PI_E2E_DEBUG_SETTLE"] === "1") console.error(`[settle] ONDATA consumed`);
          resolve(frame.t === "error" ? undefined : frame as Extract<TuiServerFrame, { t: "message" }>);
        }
      };
      this.socket?.on("data", onData);
    });
  }

  /** Send a steer frame; await its steer-ack. */
  async steer(text: string): Promise<Extract<TuiServerFrame, { t: "steer-ack" }>> {
    if (!this.socket || !this.attachedSessionId) throw new Error("TUI client not attached");
    const instructionId = `pi-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    // The adapter acks with the SERVER-generated instruction id (queueInstruction),
    // not the client-sent one — match the next steer-ack frame; steers are
    // awaited serially per scenario so the first ack is this steer's.
    const ackPromise = waitFor(
      async () => {
        const f = this.nextFrame((x) => x.t === "steer-ack");
        return f as Extract<TuiServerFrame, { t: "steer-ack" }> | undefined;
      },
      TIMEOUTS.holdSettleMs,
      `steer-ack for ${instructionId}`,
      () => `last TUI error: ${this.lastError ?? "none"}`,
    );
    this.send({ t: "steer", sessionId: this.attachedSessionId, instructionId, text });
    return ackPromise;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.frameQueue = [];
  }

  private send(frame: TuiClientFrame): void {
    if (!this.socket) throw new Error("TUI client not connected");
    if (process.env["PI_E2E_DEBUG_RAW"] === "1") console.error(`[send] ${JSON.stringify(frame).slice(0, 120)}`);
    this.socket.write(JSON.stringify(frame) + "\n");
  }

  private route(frame: TuiServerFrame): void {
    this.receivedFrames.push(JSON.stringify(frame).slice(0, 120));
    if (this.receivedFrames.length > 64) this.receivedFrames.shift();
    if (process.env["PI_E2E_DEBUG_FRAMES"] === "1") {
      console.error(`[tui-client] frame: ${JSON.stringify(frame).slice(0, 200)} waiters=${this.waiters.length}`);
    }
    // #1533: every ready frame is authoritative for attachment identity. The
    // adapter rebinds after /reset ends the attached session, so a later ready
    // replaces the current session ID before any frame is consumed — steering
    // and control frames then carry the replacement ID.
    if (frame.t === "ready") {
      this.attachedSessionId = frame.sessionId;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      if (process.env["PI_E2E_DEBUG_FRAMES"] === "1") console.error(`[tui-client] -> waiter consumed`);
      waiter(frame);
      return;
    }
    this.frameQueue.push(frame);
    if (this.frameQueue.length > 128) this.frameQueue.shift();
  }

  private nextFrame(predicate: (frame: TuiServerFrame) => boolean): TuiServerFrame | undefined {
    const index = this.frameQueue.findIndex(predicate);
    if (index >= 0) {
      const frame = this.frameQueue.splice(index, 1)[0];
      if (process.env["PI_E2E_DEBUG_FRAMES"] === "1") console.error(`[nextFrame] consumed ${JSON.stringify(frame).slice(0, 120)} queue->${this.frameQueue.length}`);
      return frame;
    }
    if (process.env["PI_E2E_DEBUG_MISS"] === "1") {
      console.error(`[nextFrame] MISS queue=${this.frameQueue.length} types=${this.frameQueue.map((f) => f.t).join(",")}`);
    }
    return undefined;
  }
}
