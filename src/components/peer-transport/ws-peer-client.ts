/**
 * ws-peer-client.ts — Persistent outbound WebSocket to a peer (#972, #1293, #1455).
 *
 * Owns exactly one connection state machine and at most one socket attempt or
 * pending reconnect timer per peer. requestConnect() coalesces repeated
 * triggers from startup, doorbell, and outbox demand.
 */
import WebSocket from "ws";
import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { signRequest } from "./peer-auth.js";
import { createPinnedPeerWsConnection } from "./pinned-peer-tls.js";
import { loadPeerConfig, type PeerEntry } from "../peer-config.js";
import { logInfo, logWarn, logDebug } from "../logger.js";
import { getPeerWsBroker } from "./peer-ws-broker.js";
import { abtarsHome } from "../../paths.js";

const TAG = "ws-peer";

export type OutboundPeerState = "idle" | "waiting" | "connecting" | "connected" | "destroyed";
export type ConnectReason = "startup" | "udp-doorbell" | "outbox";

const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;

export class WsPeerClient {
  private ws: WebSocket | null = null;
  private readonly peerName: string;
  private readonly entry: PeerEntry;
  private state: OutboundPeerState = "idle";
  private socketGeneration = 0;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(peerName: string, entry: PeerEntry) {
    this.peerName = peerName;
    this.entry = entry;
    this.socketGeneration = 1;
  }

  get peer(): string { return this.peerName; }
  get currentState(): OutboundPeerState { return this.state; }
  get connected(): boolean {
    const broker = getPeerWsBroker();
    return broker.hasRoute(this.peerName);
  }

  /**
   * Single idempotent entry point for all outbound connection triggers.
   * destroyed, waiting, connecting, and connected states are no-ops.
   * Delayed requests transition to waiting; immediate requests dial directly.
   */
  requestConnect(input: { reason: ConnectReason; delayMs?: number }): void {
    if (this.state === "destroyed") return;
    if (this.state === "waiting" || this.state === "connecting" || this.state === "connected") return;

    if (input.delayMs && input.delayMs > 0) {
      this.state = "waiting";
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.internalDial();
      }, input.delayMs).unref();
      logDebug(TAG, `requestConnect delayed ${this.peerName}: ${input.delayMs}ms (reason: ${input.reason})`);
      return;
    }

    this.internalDial();
    logDebug(TAG, `requestConnect ${this.peerName} (reason: ${input.reason})`);
  }

  destroy(): void {
    const wasDestroyed = this.state === "destroyed";
    this.state = "destroyed";
    this.socketGeneration++;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    if (!wasDestroyed) {
      logInfo(TAG, `Client destroyed: ${this.peerName}`);
    }
  }

  async send(method: string, payload: unknown): Promise<unknown> {
    const broker = getPeerWsBroker();
    if (!broker.hasRoute(this.peerName)) {
      throw new Error(`No route to ${this.peerName}`);
    }
    return broker.sendRequest(this.peerName, method, payload);
  }

  sendPush(method: string, payload: unknown): void {
    const broker = getPeerWsBroker();
    broker.sendPush(this.peerName, method, payload);
  }

  async call<T = unknown>(method: string, payload: unknown): Promise<T> {
    return (await this.send(method, payload)) as T;
  }

  /**
   * Dialer-side enrollment handshake over /v1/enroll-ws.
   */
  async enroll(tribeToken: string, selfSigningKey: string, selfVerifyKey: string, selfName: string): Promise<void> {
    const {
      macTribe, signEnroll, verifyAck,
    } = await import("./peer-auth.js");
    const { clearPeerConfigCache } = await import("../peer-config.js");

    const enrollUrl = `wss://${this.entry.host}:${this.entry.port}/v1/enroll-ws`;
    const nonceI = randomBytes(16).toString("hex");
    const tsNow = Math.floor(Date.now() / 1000);

    return new Promise((resolve, reject) => {
      const enrollWs = new WebSocket(enrollUrl, {
        minVersion: "TLSv1.3",
        rejectUnauthorized: false,
      } as any);

      let stage = 0;
      let nonceR = "";
      let enrollTimeout: ReturnType<typeof setTimeout> | null = null;

      const onEnrollMessage = async (rawData: import("ws").RawData) => {
        try {
          const msg = JSON.parse(rawData.toString());

          if (stage === 1) {
            const { pubKey_r, nonce_r, ts: _ts, mac_r } = msg as { pubKey_r: string; nonce_r: string; ts: number; mac_r: string };
            if (!pubKey_r || !nonce_r || !mac_r) { reject(new Error("Invalid challenge")); enrollWs.close(); return; }

            const expectedMacR = macTribe(tribeToken, pubKey_r + nonceI);
            if (mac_r !== expectedMacR) { reject(new Error("tribe token mismatch — not same tribe")); enrollWs.close(); return; }

            nonceR = nonce_r;
            stage = 2;

            const macI = macTribe(tribeToken, selfVerifyKey + nonceR);
            const selfSig = signEnroll(selfSigningKey, selfVerifyKey, nonceR, selfName);
            enrollWs.send(JSON.stringify({
              mac_i: macI,
              name: selfName,
              nonce_r: nonceR,
              ts: Math.floor(Date.now() / 1000),
              selfSig,
            }));
            return;
          }

          if (stage === 2) {
            const { name_r, pubKey_r: pubKeyRd, ackSig } = msg as { name_r: string; pubKey_r: string; ackSig: string };
            if (!ackSig || !name_r) { reject(new Error("Invalid ack")); enrollWs.close(); return; }

            if (!verifyAck(ackSig, pubKeyRd, name_r, pubKeyRd, nonceR)) {
              reject(new Error("Invalid ack signature")); enrollWs.close(); return;
            }

            if (enrollTimeout) { clearTimeout(enrollTimeout); enrollTimeout = null; }

            const peersPath = join(abtarsHome(), "config", "peers.json");
            let raw: Record<string, unknown> = {};
            if (existsSync(peersPath)) { try { raw = JSON.parse(require("fs").readFileSync(peersPath, "utf-8")); } catch { raw = {}; } }
            if (!raw.peers || typeof raw.peers !== "object") raw.peers = {};
            (raw.peers as Record<string, unknown>)[name_r] = {
              host: this.entry.host,
              port: this.entry.port,
              verifyKey: pubKeyRd,
              trust: 1,
              transport: "ws-outbound",
            };
            writeFileSync(peersPath, JSON.stringify(raw, null, 2) + "\n", { encoding: "utf-8" });
            clearPeerConfigCache();

            logInfo(TAG, `Enrolled with '${name_r}' at trust=1`);

            enrollWs.removeListener("message", onEnrollMessage);
            this.ws = enrollWs;
            const broker = getPeerWsBroker();
            broker.attachSocket({
              peer: this.peerName,
              direction: "outbound",
              socket: enrollWs,
            });
            this.state = "connected";
            this.backoffMs = INITIAL_BACKOFF_MS;
            enrollWs.on("close", () => this.handleClose(this.socketGeneration));
            enrollWs.on("error", (err) => this.handleError(err, this.socketGeneration));

            enrollWs.removeListener("close", onEnrollClose);
            enrollWs.removeListener("error", onEnrollError);

            resolve();
          }
        } catch (err) {
          reject(err);
          enrollWs.close();
        }
      };

      const onEnrollClose = (_code: number, _reason: Buffer) => {
        if (stage < 2) reject(new Error(`Enrollment WS closed early: ${_code} ${_reason}`));
      };

      const onEnrollError = (err: Error) => {
        reject(new Error(`Enrollment WS error: ${err.message}`));
      };

      enrollWs.on("open", () => {
        enrollWs.send(JSON.stringify({
          pubKey_i: selfVerifyKey,
          nonce_i: nonceI,
          ts: tsNow,
        }));
        stage = 1;
      });

      enrollWs.on("message", onEnrollMessage);
      enrollWs.on("error", onEnrollError);
      enrollWs.on("close", onEnrollClose);

      enrollTimeout = setTimeout(() => {
        if (stage < 2) { reject(new Error("Enrollment timeout")); enrollWs.close(); }
      }, 30_000);
    });
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private internalDial(): void {
    if (this.state === "destroyed") return;

    const config = loadPeerConfig();
    if (!this.entry.verifyKey) {
      logWarn(TAG, `Cannot connect to ${this.peerName}: no verifyKey (not enrolled)`);
      return;
    }

    const generation = ++this.socketGeneration;
    this.state = "connecting";

    const url = `wss://${this.entry.host}:${this.entry.port}/v1/ws`;
    const sigHeaders = signRequest("GET", "/v1/ws", "", config.self.signingKey, config.self.name);

    const ws = new WebSocket(url, {
      headers: sigHeaders,
      minVersion: "TLSv1.3",
      createConnection: createPinnedPeerWsConnection({ peerName: this.peerName, verifyKey: this.entry.verifyKey }),
    } as any);

    ws.on("open", () => {
      if (this.state === "destroyed" || generation !== this.socketGeneration) {
        ws.close();
        return;
      }
      logInfo(TAG, `Connected to ${this.peerName}`);
      this.ws = ws;
      this.state = "connected";
      this.backoffMs = INITIAL_BACKOFF_MS;
      (ws as any)._socket?.setKeepAlive(true, 20_000);

      // Attach socket to broker for bidirectional request/response routing
      const broker = getPeerWsBroker();
      broker.attachSocket({
        peer: this.peerName,
        direction: "outbound",
        socket: ws,
      });
    });

    ws.on("close", () => {
      if (generation !== this.socketGeneration) return;
      this.handleClose(generation);
    });

    ws.on("error", (err) => {
      if (generation !== this.socketGeneration) return;
      this.handleError(err, generation);
    });
  }

  private handleError(err: Error, generation: number): void {
    logDebug(TAG, `WS error (${this.peerName} gen=${generation}): ${err.message}`);
    this.ws?.close();
  }

  private handleClose(generation: number): void {
    if (this.state === "destroyed" || generation !== this.socketGeneration) return;

    // Settle: only the current generation can schedule recovery
    if (this.state === "connecting" || this.state === "connected") {
      this.state = "idle";
      this.ws = null;
      this.scheduleReconnect(generation);
    }
  }

  private scheduleReconnect(generation: number): void {
    if (this.state === "destroyed" || generation !== this.socketGeneration) return;
    if (this.reconnectTimer) return; // Only one pending timer

    const delay = this.backoffMs * (0.8 + Math.random() * 0.4);
    logDebug(TAG, `Reconnecting to ${this.peerName} in ${Math.round(delay)}ms (backoff: ${this.backoffMs}ms)`);
    this.state = "waiting";
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.internalDial();
    }, delay).unref();

    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }
}
