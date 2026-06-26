/**
 * ws-peer-client.ts — Persistent outbound WebSocket to a peer (#972).
 * KP connects OUT to Molty. Molty pushes callbacks/channels down the WS.
 */
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { mintPeerJwt, signBody, tlsOptions } from "./peer-auth.js";
import { loadPeerConfig, type PeerEntry } from "../peer-config.js";
import { logInfo, logWarn, logDebug } from "../logger.js";

const TAG = "ws-peer";
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

type PushHandler = (method: string, payload: unknown) => void;
type PendingRequest = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class WsPeerClient {
  private ws: WebSocket | null = null;
  private peerName: string;
  private entry: PeerEntry;
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private pushHandler: PushHandler | null = null;
  private pending = new Map<string, PendingRequest>();
  private destroyed = false;

  constructor(peerName: string, entry: PeerEntry) {
    this.peerName = peerName;
    this.entry = entry;
  }

  onPush(handler: PushHandler): void { this.pushHandler = handler; }

  connect(): void {
    if (this.destroyed) return;
    const url = `wss://${this.entry.host}:${this.entry.port}/v1/ws`;
    const jwt = mintPeerJwt(this.peerName);
    const tls = tlsOptions(this.entry);

    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${jwt}` },
      ...tls,
    } as any);

    this.ws.on("open", () => {
      logInfo(TAG, `Connected to ${this.peerName}`);
      this.backoff = 1000;
      this.startPing();
    });

    this.ws.on("message", (data) => this.handleMessage(data.toString()));

    this.ws.on("pong", () => {
      if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    });

    this.ws.on("close", () => {
      this.cleanup();
      if (!this.destroyed) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      logDebug(TAG, `WS error (${this.peerName}): ${err.message}`);
      this.ws?.close();
    });
  }

  async send(method: string, payload: unknown): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WS not connected to ${this.peerName}`);
    }
    const id = randomUUID();
    const config = loadPeerConfig();
    const body = JSON.stringify(payload);
    const signed = await signBody(this.peerName, body, config.self.signingKey, config.self.name);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WS request timeout (${this.peerName}/${method})`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ type: "request", id, method, payload: JSON.parse(signed) }));
    });
  }

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.cleanup();
    this.ws?.close();
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "response" && msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg.payload);
      } else if (msg.type === "push") {
        this.pushHandler?.(msg.method, msg.payload);
      }
    } catch { /* malformed — ignore */ }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.ping();
      this.pongTimer = setTimeout(() => {
        logWarn(TAG, `No pong from ${this.peerName} — closing`);
        this.ws?.terminate();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private cleanup(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    // Reject all pending requests
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("WS connection closed"));
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    const jitter = this.backoff * (0.8 + Math.random() * 0.4); // ±20%
    logDebug(TAG, `Reconnecting to ${this.peerName} in ${Math.round(jitter)}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), jitter);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }
}
