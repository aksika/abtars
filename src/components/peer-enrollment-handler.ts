import { IncomingMessage } from "http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { abtarsHome } from "../paths.js";
import { logWarn, logInfo } from "./logger.js";
import { loadPeerConfig, deriveVerifyKey, clearPeerConfigCache } from "./peer-config.js";
import type { PeerConfig } from "./peer-config.js";
import { macTribe, verifyEnroll, signAck } from "./peer-transport/peer-auth.js";

/**
 * #1557 — Peer enrollment (responder side) extracted from AgentApiServer.
 *
 * One long-lived PeerEnrollmentHandler owns the shared per-IP rate limiter
 * and creates one isolated PeerEnrollmentSession per accepted socket. The
 * session owns stage, initiator key, responder nonce, and named socket
 * listeners. Production callbacks retain the current config/persistence and
 * registerPeerWs() behavior; tests drive the session through socket events
 * with deterministic time and nonces.
 */

const TAG = "agent-api";
export const ENROLL_RATE_MS = 5 * 60 * 1000; // 1 per 5 min per IP

export type EnrollmentStage =
  | "awaiting_knock"
  | "awaiting_enroll"
  | "promoting"
  | "steady_state"
  | "closed";

type PeerSocket = import("ws").WebSocket;

export interface PeerEnrollmentDeps {
  /** Register the socket for steady-state peer messaging (socket promotion). */
  registerPeerWs(peerName: string, ws: PeerSocket): void;
  loadPeerConfig?: () => PeerConfig;
  deriveVerifyKey?: (signingKey: string) => string;
  macTribe?: (tribeToken: string, ...parts: string[]) => string;
  verifyEnroll?: (selfSig: string, verifyKey: string, pubKeyI: string, nonceR: string, name: string) => boolean;
  signAck?: (signingKey: string, nameR: string, pubKeyR: string, nonceR: string) => string;
  clearPeerConfigCache?: () => void;
  randomBytes?: (size: number) => Buffer;
  /** Milliseconds since epoch — deterministic in tests. */
  now?: () => number;
  /** Read the raw peers.json (fresh copy — no cache). */
  readPeersJson?: () => Record<string, unknown>;
  /** Write the merged peers.json. */
  writePeersJson?: (raw: Record<string, unknown>) => void;
  logWarn?: (tag: string, msg: string) => void;
  logInfo?: (tag: string, msg: string) => void;
}

interface ResolvedPeerEnrollmentDeps {
  registerPeerWs: (peerName: string, ws: PeerSocket) => void;
  loadPeerConfig: () => PeerConfig;
  deriveVerifyKey: (signingKey: string) => string;
  macTribe: (tribeToken: string, ...parts: string[]) => string;
  verifyEnroll: (selfSig: string, verifyKey: string, pubKeyI: string, nonceR: string, name: string) => boolean;
  signAck: (signingKey: string, nameR: string, pubKeyR: string, nonceR: string) => string;
  clearPeerConfigCache: () => void;
  randomBytes: (size: number) => Buffer;
  now: () => number;
  readPeersJson: () => Record<string, unknown>;
  writePeersJson: (raw: Record<string, unknown>) => void;
  logWarn: (tag: string, msg: string) => void;
  logInfo: (tag: string, msg: string) => void;
}

/** Self identity context resolved once per accepted socket. */
export interface PeerEnrollmentSelf {
  name: string;
  signingKey: string;
  tribeToken: string;
  /** Derived public key — sent in the challenge and the acknowledgement. */
  verifyKey: string;
}

function readPeersJsonDefault(): Record<string, unknown> {
  const p = join(abtarsHome(), "config", "peers.json");
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
}

function writePeersJsonDefault(raw: Record<string, unknown>): void {
  const p = join(abtarsHome(), "config", "peers.json");
  writeFileSync(p, JSON.stringify(raw, null, 2) + "\n", { encoding: "utf-8" });
}

function normalizeIp(raw: string): string {
  return raw.replace(/^::ffff:/, "");
}

/**
 * #1557 — Per-socket enrollment state machine. Stage transitions:
 * awaiting_knock -> awaiting_enroll -> promoting -> steady_state | closed.
 * A second frame received after the enroll frame starts promotion cannot
 * cause a second persistence or promotion attempt: promotion happens under
 * the "promoting" stage (any further frame is a protocol violation), and
 * successful promotion detaches the enrollment listeners entirely.
 * Closing or erroring a socket is terminal.
 */
export class PeerEnrollmentSession {
  private stage: EnrollmentStage = "awaiting_knock";
  private pubKeyI = "";
  private readonly nonceR: string;
  private readonly deps: ResolvedPeerEnrollmentDeps;
  private readonly ws: PeerSocket;
  private readonly ip: string;
  private readonly port: number;
  private readonly self: PeerEnrollmentSelf;

  private readonly onMessage: (rawData: import("ws").RawData) => void;
  private readonly onClose: () => void;
  private readonly onError: () => void;

  constructor(
    ws: PeerSocket,
    ip: string,
    port: number,
    self: PeerEnrollmentSelf,
    deps: ResolvedPeerEnrollmentDeps,
  ) {
    this.ws = ws;
    this.ip = ip;
    this.port = port;
    this.self = self;
    this.deps = deps;
    this.nonceR = deps.randomBytes(16).toString("hex");

    this.onMessage = (rawData) => { void this.handleFrame(rawData); };
    this.onClose = () => { this.stage = "closed"; };
    this.onError = () => { this.stage = "closed"; };

    ws.on("message", this.onMessage);
    ws.on("close", this.onClose);
    ws.on("error", this.onError);
  }

  getStage(): EnrollmentStage {
    return this.stage;
  }

  /** True when the session can no longer persist, promote, or acknowledge. */
  isTerminal(): boolean {
    return this.stage === "closed" || this.stage === "steady_state";
  }

  private async handleFrame(rawData: import("ws").RawData): Promise<void> {
    try {
      const msg = JSON.parse(rawData.toString());

      if (this.stage === "awaiting_knock") {
        // Step A: knock
        const { pubKey_i, nonce_i, ts } = msg as { pubKey_i: string; nonce_i: string; ts: number };
        if (!pubKey_i || !nonce_i || !ts) { this.ws.close(1008, "invalid knock"); return; }
        const nowSec = Math.floor(this.deps.now() / 1000);
        if (Math.abs(nowSec - ts) > 30) { this.ws.close(1008, "stale ts"); return; }

        this.pubKeyI = pubKey_i;
        this.stage = "awaiting_enroll";

        // Step B: challenge
        const macR = this.deps.macTribe(this.self.tribeToken, this.self.verifyKey + nonce_i);
        this.ws.send(JSON.stringify({ pubKey_r: this.self.verifyKey, nonce_r: this.nonceR, ts: nowSec, mac_r: macR }));
        return;
      }

      if (this.stage === "awaiting_enroll") {
        // Step C: enroll — transition to promoting BEFORE the first await.
        // Every continuation below re-checks terminal state before any side
        // effect, so a second frame racing this one can never repeat
        // persistence or promotion.
        this.stage = "promoting";

        const { mac_i, name, nonce_r, ts, selfSig } = msg as { mac_i: string; name: string; nonce_r: string; ts: number; selfSig: string };
        if (!mac_i || !name || !nonce_r || !selfSig) { this.ws.close(1008, "invalid enroll msg"); return; }

        if (nonce_r !== this.nonceR) { this.ws.close(1008, "nonce mismatch"); return; }

        const nowSec = Math.floor(this.deps.now() / 1000);
        if (Math.abs(nowSec - ts) > 30) { this.ws.close(1008, "stale ts"); return; }

        // Verify mac_i
        const expectedMacI = this.deps.macTribe(this.self.tribeToken, this.pubKeyI + this.nonceR);
        if (mac_i !== expectedMacI) { this.ws.close(1008, "mac mismatch"); this.stage = "closed"; return; }

        // Verify selfSig
        if (!this.deps.verifyEnroll(selfSig, this.pubKeyI, this.pubKeyI, this.nonceR, name)) {
          this.ws.close(1008, "bad selfSig"); this.stage = "closed"; return;
        }

        // Pin-and-alert: reject if existing peer has different verifyKey
        const config = this.deps.loadPeerConfig();
        const existing = config.peers[name];
        if (existing && existing.verifyKey !== this.pubKeyI) {
          this.deps.logWarn(TAG, `Enrollment rejected — peer '${name}' verifyKey changed (pin-and-alert)`);
          this.ws.close(1008, "key changed — operator action required"); this.stage = "closed"; return;
        }

        // Persist peer (first I/O — stage is already "promoting")
        const raw = this.deps.readPeersJson();
        if (!raw.peers || typeof raw.peers !== "object") raw.peers = {};
        (raw.peers as Record<string, unknown>)[name] = {
          host: this.ip,
          port: this.port,
          verifyKey: this.pubKeyI,
          trust: 1,
        };
        this.deps.writePeersJson(raw);
        this.deps.clearPeerConfigCache();

        this.deps.logInfo(TAG, `Enrolled new peer '${name}' from ${this.ip} at trust=1`);

        // Build ack payload
        const ackSig = this.deps.signAck(this.self.signingKey, this.self.name, this.self.verifyKey, this.nonceR);
        const ackPayload = JSON.stringify({ name_r: this.self.name, pubKey_r: this.self.verifyKey, ackSig });

        // Detach handshake message listener
        this.ws.removeListener("message", this.onMessage);
        this.ws.removeListener("close", this.onClose);
        this.ws.removeListener("error", this.onError);

        // Register for steady-state messaging (BEFORE sending ack)
        if (this.ws.readyState === this.ws.OPEN) {
          this.deps.registerPeerWs(name, this.ws);
          this.stage = "steady_state";
          this.ws.send(ackPayload);
        } else {
          this.stage = "closed";
        }
        return;
      }

      // Any message in promoting/steady_state/closed is a protocol violation
      this.ws.close(1008, "unexpected frame after enrollment");
    } catch (err) {
      this.deps.logWarn(TAG, `Enrollment error from ${this.ip}: ${err instanceof Error ? err.message : String(err)}`);
      this.ws.close(1011, "enrollment error");
    }
  }
}

/**
 * #1557 — Long-lived enrollment handler. Owns the per-IP rate limiter;
 * creates one isolated session per accepted socket.
 */
export class PeerEnrollmentHandler {
  private readonly attemptsByIp = new Map<string, number>();
  private readonly deps: ResolvedPeerEnrollmentDeps;

  constructor(deps: PeerEnrollmentDeps) {
    this.deps = {
      registerPeerWs: deps.registerPeerWs,
      loadPeerConfig: deps.loadPeerConfig ?? loadPeerConfig,
      deriveVerifyKey: deps.deriveVerifyKey ?? deriveVerifyKey,
      macTribe: deps.macTribe ?? macTribe,
      verifyEnroll: deps.verifyEnroll ?? verifyEnroll,
      signAck: deps.signAck ?? signAck,
      clearPeerConfigCache: deps.clearPeerConfigCache ?? clearPeerConfigCache,
      randomBytes: deps.randomBytes ?? ((size: number) => cryptoRandomBytes(size)),
      now: deps.now ?? (() => Date.now()),
      readPeersJson: deps.readPeersJson ?? readPeersJsonDefault,
      writePeersJson: deps.writePeersJson ?? writePeersJsonDefault,
      logWarn: deps.logWarn ?? ((tag, msg) => logWarn(tag, msg)),
      logInfo: deps.logInfo ?? ((tag, msg) => logInfo(tag, msg)),
    };
  }

  /**
   * Accept an upgraded /v1/enroll-ws socket: normalize the address, check and
   * record the per-IP rate limit, resolve the responder identity, and hand
   * the socket to a fresh session with named listeners.
   */
  async accept(ws: PeerSocket, req: IncomingMessage): Promise<void> {
    const ip = normalizeIp(req.socket?.remoteAddress ?? "");
    const lastAttempt = this.attemptsByIp.get(ip) ?? 0;
    if (this.deps.now() - lastAttempt < ENROLL_RATE_MS) {
      this.deps.logWarn(TAG, `Enrollment rate-limit hit for ${ip}`);
      ws.close(1008, "rate limited");
      return;
    }
    this.attemptsByIp.set(ip, this.deps.now());

    const config = this.deps.loadPeerConfig();
    const self: PeerEnrollmentSelf = {
      name: config.self.name,
      signingKey: config.self.signingKey,
      tribeToken: config.self.tribeToken,
      verifyKey: this.deps.deriveVerifyKey(config.self.signingKey),
    };
    const port = parseInt(req.headers["x-peer-port"] as string ?? "0", 10) || 0;

    new PeerEnrollmentSession(ws, ip, port, self, this.deps);
  }
}
