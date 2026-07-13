/**
 * ws-peer-client.ts — Persistent outbound WebSocket to a peer (#972, #1293).
 *
 * #1401 changes:
 * - Durable outbox (WsOutboxStore) with atomic checkpoint on every mutation.
 * - Stable request ID assigned at enqueue, reused on every retry.
 * - Serial pump: one entry in flight at a time, removed only after correlated
 *   success response.
 * - `destroy()` preserves the outbox; `purgeOutbox()` for explicit removal.
 * - Corrupt checkpoints quarantined, not silently reset.
 */
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { signRequest } from "./peer-auth.js";
import { createPinnedPeerWsConnection } from "./pinned-peer-tls.js";
import { loadPeerConfig, deriveVerifyKey, type PeerEntry } from "../peer-config.js";
import { logInfo, logWarn, logDebug } from "../logger.js";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { WsOutboxStore } from "./ws-outbox-store.js";

const TAG = "ws-peer";
const MAX_BACKOFF_MS = 30_000;
const OUTBOX_TIMEOUT_MS = 30_000;
const OUTBOX_MAX = 200;
const OUTBOX_MAX_ENTRY_BYTES = 512 * 1024;   // 512 KiB per entry
const OUTBOX_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB total

type PushHandler = (method: string, payload: unknown) => void;
type PendingWaiter = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

interface InFlight {
  entryId: string;
  timer: ReturnType<typeof setTimeout>;
}

export class WsPeerClient {
  private ws: WebSocket | null = null;
  private readonly peerName: string;
  private readonly entry: PeerEntry;
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pushHandler: PushHandler | null = null;
  /** #1401 — Runtime waiters for connected callers (keyed by stable outbox ID). */
  private waiters = new Map<string, PendingWaiter>();
  private destroyed = false;
  /** #1401 — Durable outbox: entries survive disconnect, timeout, restart. */
  private readonly outbox: WsOutboxStore;
  /** #1401 — Currently in-flight entry (at most one at a time). */
  private inFlight: InFlight | null = null;
  /** #1401 — Monotonic generation counter for socket identity. */
  private sockGen = 0;

  constructor(peerName: string, entry: PeerEntry) {
    this.peerName = peerName;
    this.entry = entry;
    const filePath = join(abtarsHome(), `ws-outbox-${peerName}.json`);
    this.outbox = new WsOutboxStore({
      peerName,
      filePath,
      maxEntries: OUTBOX_MAX,
      maxEntryBytes: OUTBOX_MAX_ENTRY_BYTES,
      maxFileBytes: OUTBOX_MAX_FILE_BYTES,
    });
  }

  onPush(handler: PushHandler): void { this.pushHandler = handler; }

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

    const myGen = ++this.sockGen;

    this.ws.on("open", () => {
      logInfo(TAG, `Connected to ${this.peerName}`);
      this.backoff = 1000;
      (this.ws as any)._socket?.setKeepAlive(true, 20_000);

      // #1360: Send our signed status immediately on connect
      try {
        const { loadPeerConfig } = require("../peer-config.js") as typeof import("../peer-config.js");
        const { buildSignedStatus } = require("./peer-health.js") as typeof import("./peer-health.js");
        const config = loadPeerConfig();
        const signed = buildSignedStatus(config.self.signingKey);
        this.ws!.send(JSON.stringify({ type: "push", method: "peer-status.v1", payload: signed }));
      } catch { /* best effort */ }

      this.pump(myGen);
    });

    this.ws.on("message", (data) => this.handleMessage(data.toString(), myGen));

    this.ws.on("close", () => {
      this.clearInFlight();
      this.rejectWaiters(new Error("WS connection closed"));
      if (!this.destroyed) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      logDebug(TAG, `WS error (${this.peerName}): ${err.message}`);
      this.ws?.close();
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * #1401 — Send a message over the WSS outbox.
   * Always creates a durable entry first.  If connected, the pump sends it.
   * Returns a promise that resolves on correlated success or rejects on
   * terminal failure / client shutdown.
   */
  async send(method: string, payload: unknown): Promise<unknown> {
    if (this.outbox.isDegraded) throw new Error(`Outbox degraded for ${this.peerName}`);
    if (this.outbox.isFull) throw new Error(`Outbox full for ${this.peerName} (max ${OUTBOX_MAX})`);

    const entry = this.outbox.append(method, payload);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(entry.id);
        reject(new Error(`Outbox timeout (${this.peerName}/${method})`));
      }, OUTBOX_TIMEOUT_MS);
      this.waiters.set(entry.id, { resolve, reject, timer });
      this.pump(this.sockGen);
    });
  }

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  /** #1360: Send an ephemeral push (not through the durable outbox). */
  sendPush(method: string, payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "push", method, payload }));
    }
  }

  /** #1358: Call a method and wait for a correlated response. Alias for send(). */
  async call(method: string, payload: unknown): Promise<unknown> {
    return this.send(method, payload);
  }

  /** #1401 — Close runtime resources. Outbox entries survive for the next client/process. */
  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearInFlight();
    this.rejectWaiters(new Error("WsPeerClient destroyed"));
    this.ws?.close();
  }

  /** #1401 — Explicit operator/test destructive action. */
  purgeOutbox(): void {
    this.outbox.purge();
  }

  // ── Pump ─────────────────────────────────────────────────────────────────

  /** #1401 — Serial pump: send the oldest entry if nothing is in flight. */
  private pump(gen: number): void {
    if (this.destroyed) return;
    if (this.inFlight) return;
    if (this.outbox.isDegraded) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const entry = this.outbox.peek();
    if (!entry) return;

    this.outbox.recordAttempt(entry.id);

    const config = loadPeerConfig();
    const payloadStr = JSON.stringify(entry.payload);
    const sigHeaders = signRequest("POST", `/${entry.method}`, payloadStr, config.self.signingKey, config.self.name);
    const frame = JSON.stringify({ type: "request", id: entry.id, method: entry.method, payload: entry.payload, ...sigHeaders });

    const timer = setTimeout(() => {
      // Timeout — clear in-flight, keep entry, let next pump retry
      if (gen !== this.sockGen) return;
      this.outbox.recordAttempt(entry.id, "timeout");
      this.clearInFlight();
      this.pump(gen);
    }, OUTBOX_TIMEOUT_MS);

    this.inFlight = { entryId: entry.id, timer };
    this.ws.send(frame);
  }

  /** Clear in-flight state without affecting durable entries. */
  private clearInFlight(): void {
    if (this.inFlight) {
      clearTimeout(this.inFlight.timer);
      this.inFlight = null;
    }
  }

  // ── Response handling ────────────────────────────────────────────────────

  private handleMessage(raw: string, gen: number): void {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === "response" && msg.id) {
        // #1401 — correlated success: acknowledge the durable entry
        if (this.inFlight && this.inFlight.entryId === msg.id) {
          this.outbox.acknowledge(msg.id);
          this.clearInFlight();
        }

        // Settle the runtime waiter if present
        const w = this.waiters.get(msg.id);
        if (w) {
          this.waiters.delete(msg.id);
          clearTimeout(w.timer);
          if (msg.error) {
            w.reject(new Error(String(msg.error)));
          } else {
            w.resolve(msg.payload);
          }
        }

        // Pump the next entry
        if (gen === this.sockGen) this.pump(gen);
      } else if (msg.type === "push") {
        this.pushHandler?.(msg.method, msg.payload);
      }
    } catch { /* malformed — ignore */ }
  }

  /** Reject all outstanding waiters (e.g. on close/destroy). Entries survive. */
  private rejectWaiters(err: Error): void {
    for (const [, w] of this.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters.clear();
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
    const { randomBytes } = await import("node:crypto");
    const {
      macTribe, signEnroll, verifyAck,
    } = await import("./peer-auth.js");
    const { clearPeerConfigCache } = await import("../peer-config.js");
    const { writeFileSync, existsSync: exSync } = await import("node:fs");

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
      let enrollTimeout: ReturnType<typeof setTimeout> | null = null;

      const onEnrollMessage = async (rawData: import("ws").RawData) => {
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

            // Clear enrollment timeout
            if (enrollTimeout) { clearTimeout(enrollTimeout); enrollTimeout = null; }

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

            // Detach enrollment message handler, keep socket as steady-state connection
            enrollWs.removeListener("message", onEnrollMessage);
            this.ws = enrollWs;
            enrollWs.on("message", (data) => this.handleMessage(data.toString()));
            enrollWs.on("close", () => { this.cleanup(); if (!this.destroyed) this.scheduleReconnect(); });
            enrollWs.on("error", (err) => { logDebug(TAG, `WS error (${this.peerName}): ${err.message}`); this.ws?.close(); });

            // Remove handshake-only close handler (steady-state close is installed above)
            enrollWs.removeListener("close", onEnrollClose);
            // Remove handshake-only error handler (steady-state error is installed above)
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
        // Step A: knock
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
