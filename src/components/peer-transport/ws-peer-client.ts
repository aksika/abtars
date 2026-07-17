/**
 * ws-peer-client.ts — Persistent outbound WebSocket to a peer (#972, #1293).
 *
 * #1433: owns only dial/reconnect/TLS lifecycle. Attaches each open socket
 * to the shared PeerWsBroker for bidirectional request/response routing.
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
const MAX_BACKOFF_MS = 30_000;

export class WsPeerClient {
  private ws: WebSocket | null = null;
  private readonly peerName: string;
  private readonly entry: PeerEntry;
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(peerName: string, entry: PeerEntry) {
    this.peerName = peerName;
    this.entry = entry;
  }

  onPush(_handler: (method: string, payload: unknown) => void): void { /* pushes handled by broker */ }

  connect(): void {
    if (this.destroyed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const config = loadPeerConfig();
    if (!this.entry.verifyKey) {
      logWarn(TAG, `Cannot connect to ${this.peerName}: no verifyKey (not enrolled)`);
      return;
    }

    const url = `wss://${this.entry.host}:${this.entry.port}/v1/ws`;
    const sigHeaders = signRequest("GET", "/v1/ws", "", config.self.signingKey, config.self.name);

    this.ws = new WebSocket(url, {
      headers: sigHeaders,
      minVersion: "TLSv1.3",
      createConnection: createPinnedPeerWsConnection({ peerName: this.peerName, verifyKey: this.entry.verifyKey }),
    } as any);

    this.ws.on("open", () => {
      logInfo(TAG, `Connected to ${this.peerName}`);
      this.backoff = 1000;
      (this.ws as any)._socket?.setKeepAlive(true, 20_000);

      // #1433: Attach this socket to the shared broker
      const broker = getPeerWsBroker();
      broker.attachSocket({
        peer: this.peerName,
        direction: "outbound",
        socket: this.ws!,
      });

      // Send signed status + inventory on connect
      try {
        const { loadPeerConfig } = require("../peer-config.js") as typeof import("../peer-config.js");
        const { buildSignedStatus } = require("./peer-health.js") as typeof import("./peer-health.js");
        const { buildSignedInventory } = require("./peer-inventory.js") as typeof import("./peer-inventory.js");
        const { getLocalCapabilities } = require("./gossip.js") as typeof import("./gossip.js");
        const config = loadPeerConfig();
        const signed = buildSignedStatus(config.self.signingKey);
        broker.sendPush(this.peerName, "peer-status.v1", signed);
        const inv = buildSignedInventory(config.self.signingKey, config.self.name, process.env["npm_package_version"] ?? "0.0.0", getLocalCapabilities(), ["wss", "https"]);
        broker.sendPush(this.peerName, "peer.inventory.v1", inv);
      } catch { /* best effort */ }
    });

    this.ws.on("close", () => {
      if (!this.destroyed) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      logDebug(TAG, `WS error (${this.peerName}): ${err.message}`);
      this.ws?.close();
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async send(method: string, payload: unknown): Promise<unknown> {
    const broker = getPeerWsBroker();
    if (!broker.hasRoute(this.peerName)) {
      throw new Error(`No route to ${this.peerName}`);
    }
    return broker.sendRequest(this.peerName, method, payload);
  }

  get connected(): boolean {
    const broker = getPeerWsBroker();
    return broker.hasRoute(this.peerName);
  }

  sendPush(method: string, payload: unknown): void {
    const broker = getPeerWsBroker();
    broker.sendPush(this.peerName, method, payload);
  }

  async call<T = unknown>(method: string, payload: unknown): Promise<T> {
    return (await this.send(method, payload)) as T;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  // ── Reconnect ────────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    const jitter = this.backoff * (0.8 + Math.random() * 0.4);
    logDebug(TAG, `Reconnecting to ${this.peerName} in ${Math.round(jitter)}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, jitter);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  /**
   * Dialer-side enrollment handshake over /v1/enroll-ws.
   * Called by `abtars tribe join`.
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

            // Detach enrollment message handler, attach to broker for steady-state
            enrollWs.removeListener("message", onEnrollMessage);
            this.ws = enrollWs;
            const broker = getPeerWsBroker();
            broker.attachSocket({
              peer: this.peerName,
              direction: "outbound",
              socket: enrollWs,
            });
            enrollWs.on("close", () => { if (!this.destroyed) this.scheduleReconnect(); });
            enrollWs.on("error", (err) => { logDebug(TAG, `WS error (${this.peerName}): ${err.message}`); this.ws?.close(); });

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
}
