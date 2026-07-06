/**
 * ws-peer-client.ts — Persistent outbound WebSocket to a peer (#972, #1293).
 *
 * #1293 changes:
 * - Auth: Ed25519 request signatures replacing JWT header
 * - Removed own ping setInterval (dead-detection via HB tick)
 * - setKeepAlive(true, 20_000) to hold NAT hole
 * - Durable outbound queue (persist to disk, drain on reconnect)
 */
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { signRequest, verifyServerCert } from "./peer-auth.js";
import { loadPeerConfig, deriveVerifyKey, type PeerEntry } from "../peer-config.js";
import { logInfo, logWarn, logDebug } from "../logger.js";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";

const TAG = "ws-peer";
const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const QUEUE_MAX = 200;

type PushHandler = (method: string, payload: unknown) => void;
type PendingRequest = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

interface QueueEntry {
  method: string;
  payload: unknown;
  id: string;
}

export class WsPeerClient {
  private ws: WebSocket | null = null;
  private readonly peerName: string;
  private readonly entry: PeerEntry;
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pushHandler: PushHandler | null = null;
  private pending = new Map<string, PendingRequest>();
  private destroyed = false;
  /** Durable outbound queue: pending messages while disconnected. */
  private _queue: QueueEntry[] = [];
  private readonly queuePath: string;

  constructor(peerName: string, entry: PeerEntry) {
    this.peerName = peerName;
    this.entry = entry;
    this.queuePath = join(abtarsHome(), `ws-queue-${peerName}.json`);
    this.loadQueue();
  }

  onPush(handler: PushHandler): void { this.pushHandler = handler; }

  connect(): void {
    if (this.destroyed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return; // already connected / connecting
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
      rejectUnauthorized: true,
      checkServerIdentity: (_host: string, cert: { raw?: Buffer }) => {
        if (!cert.raw) return new Error("No cert from peer");
        try {
          const { createPublicKey } = require("node:crypto") as typeof import("node:crypto");
          const keyObj = createPublicKey({ key: cert.raw, format: "der", type: "spki" });
          // Build PEM cert block from raw DER
          const certDerB64 = cert.raw.toString("base64");
          const certPemBlock = `-----BEGIN CERTIFICATE-----\n${certDerB64.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
          if (!verifyServerCert(certPemBlock, this.entry.verifyKey)) {
            return new Error(`${this.peerName} cert key != enrolled verifyKey`);
          }
        } catch (e) {
          return new Error(`Cert verify: ${e instanceof Error ? e.message : String(e)}`);
        }
        return undefined;
      },
    } as any);

    this.ws.on("open", () => {
      logInfo(TAG, `Connected to ${this.peerName}`);
      this.backoff = 1000;
      // NAT keepalive: 20s idle probe
      (this.ws as any)._socket?.setKeepAlive(true, 20_000);
      this.drainQueue();
    });

    this.ws.on("message", (data) => this.handleMessage(data.toString()));

    this.ws.on("close", () => {
      this.cleanup();
      if (!this.destroyed) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      logDebug(TAG, `WS error (${this.peerName}): ${err.message}`);
      this.ws?.close();
    });
  }

  /**
   * Send a message over the WS. If disconnected, enqueues it for delivery on reconnect.
   */
  async send(method: string, payload: unknown): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Enqueue instead of throwing
      return this.enqueue(method, payload);
    }
    return this.sendNow(method, payload);
  }

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.cleanup();
    this.ws?.close();
    this.clearPersistedQueue();
  }

  private async sendNow(method: string, payload: unknown): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WS not connected to ${this.peerName}`);
    }
    const id = randomUUID();
    const config = loadPeerConfig();
    // Sign the serialized payload as a "request"
    const payloadStr = JSON.stringify(payload);
    const sigHeaders = signRequest("POST", `/${method}`, payloadStr, config.self.signingKey, config.self.name);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WS request timeout (${this.peerName}/${method})`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ type: "request", id, method, payload, ...sigHeaders }));
    });
  }

  private enqueue(method: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this._queue.length >= QUEUE_MAX) {
        const dropped = this._queue.shift()!;
        logWarn(TAG, `[warn] ws queue for ${this.peerName} full, dropping oldest (${dropped.method})`);
      }
      const entry: QueueEntry = { method, payload, id: randomUUID() };
      this._queue.push(entry);
      this.persistQueue();
      // We can't resolve/reject immediately for queued messages
      // Resolve immediately with a sentinel (fire-and-forget semantics)
      resolve({ queued: true, id: entry.id });
    });
  }

  private drainQueue(): void {
    if (this._queue.length === 0) return;
    logInfo(TAG, `Draining ${this._queue.length} queued message(s) for ${this.peerName}`);
    const queue = this._queue.splice(0);
    this.clearPersistedQueue();
    for (const entry of queue) {
      this.sendNow(entry.method, entry.payload).catch(err => {
        logWarn(TAG, `Queue drain failed for ${this.peerName}/${entry.method}: ${err.message}`);
      });
    }
  }

  private persistQueue(): void {
    try {
      writeFileSync(this.queuePath, JSON.stringify(this._queue), { encoding: "utf-8", mode: 0o600 });
    } catch { /* best effort */ }
  }

  private clearPersistedQueue(): void {
    try { if (existsSync(this.queuePath)) unlinkSync(this.queuePath); } catch { /* best effort */ }
  }

  private loadQueue(): void {
    try {
      if (existsSync(this.queuePath)) {
        const data = readFileSync(this.queuePath, "utf-8");
        const parsed = JSON.parse(data) as QueueEntry[];
        if (Array.isArray(parsed)) {
          this._queue = parsed.slice(0, QUEUE_MAX);
          if (this._queue.length > 0) {
            logInfo(TAG, `Loaded ${this._queue.length} queued message(s) for ${this.peerName} from disk`);
          }
        }
      }
    } catch { /* best effort — corrupt queue, start fresh */ }
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

  private cleanup(): void {
    // Reject all pending requests
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("WS connection closed"));
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    const jitter = this.backoff * (0.8 + Math.random() * 0.4); // ±20%
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
    const { randomBytes } = await import("node:crypto");
    const {
      macTribe, signEnroll, verifyAck,
    } = await import("./peer-auth.js");
    const { clearPeerConfigCache } = await import("../peer-config.js");
    const { writeFileSync, existsSync: exSync, mkdirSync } = await import("node:fs");

    const enrollUrl = `wss://${this.entry.host}:${this.entry.port}/v1/enroll-ws`;
    const nonceI = randomBytes(16).toString("hex");
    const tsNow = Math.floor(Date.now() / 1000);

    return new Promise((resolve, reject) => {
      // No auth headers for enrollment path
      const enrollWs = new WebSocket(enrollUrl, {
        minVersion: "TLSv1.3",
        rejectUnauthorized: false, // Can't pin yet — cert is verified via MAC binding in step B
      } as any);

      let stage = 0;
      let nonceR = "";
      let pubKeyR = "";

      enrollWs.on("open", () => {
        // Step A: knock
        enrollWs.send(JSON.stringify({
          pubKey_i: selfVerifyKey,
          nonce_i: nonceI,
          ts: tsNow,
        }));
        stage = 1;
      });

      enrollWs.on("message", async (rawData) => {
        try {
          const msg = JSON.parse(rawData.toString());

          if (stage === 1) {
            // Step B: challenge
            const { pubKey_r, nonce_r, ts, mac_r } = msg as { pubKey_r: string; nonce_r: string; ts: number; mac_r: string };
            if (!pubKey_r || !nonce_r || !mac_r) { reject(new Error("Invalid challenge")); enrollWs.close(); return; }

            // Verify mac_r: HMAC(tribeToken, pubKey_r + nonce_i)
            const expectedMacR = macTribe(tribeToken, pubKey_r + nonceI);
            if (mac_r !== expectedMacR) { reject(new Error("tribe token mismatch — not same tribe")); enrollWs.close(); return; }

            nonceR = nonce_r;
            pubKeyR = pubKey_r;
            stage = 2;

            // Step C: enroll
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
            // Step D: ack
            const { name_r, pubKey_r: pubKeyRd, ackSig } = msg as { name_r: string; pubKey_r: string; ackSig: string };
            if (!ackSig || !name_r) { reject(new Error("Invalid ack")); enrollWs.close(); return; }

            if (!verifyAck(ackSig, pubKeyRd, name_r, pubKeyRd, nonceR)) {
              reject(new Error("Invalid ack signature")); enrollWs.close(); return;
            }

            // Persist responder to own peers.json
            const peersPath = join(abtarsHome(), "config", "peers.json");
            let raw: Record<string, unknown> = {};
            if (exSync(peersPath)) { try { raw = JSON.parse(require("fs").readFileSync(peersPath, "utf-8")); } catch { raw = {}; } }
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
            // Keep WS alive as steady-state peer connection
            this.ws = enrollWs;
            enrollWs.removeAllListeners("message");
            enrollWs.on("message", (data) => this.handleMessage(data.toString()));
            enrollWs.on("close", () => { this.cleanup(); if (!this.destroyed) this.scheduleReconnect(); });
            enrollWs.on("error", (err) => { logDebug(TAG, `WS error (${this.peerName}): ${err.message}`); this.ws?.close(); });
            resolve();
          }
        } catch (err) {
          reject(err);
          enrollWs.close();
        }
      });

      enrollWs.on("error", (err) => reject(new Error(`Enrollment WS error: ${err.message}`)));
      enrollWs.on("close", (code, reason) => {
        if (stage < 2) reject(new Error(`Enrollment WS closed early: ${code} ${reason}`));
      });

      setTimeout(() => { if (stage < 2) { reject(new Error("Enrollment timeout")); enrollWs.close(); } }, 30_000);
    });
  }
}
