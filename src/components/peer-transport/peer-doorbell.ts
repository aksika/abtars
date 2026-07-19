import { createSocket, type Socket, type RemoteInfo } from "node:dgram";
import { logInfo, logWarn, logTrace } from "../logger.js";
import { loadPeerConfig, deriveVerifyKey } from "../peer-config.js";
import {
  DOORBELL_PORT,
  MAX_QUERY_BYTES,
  TIMESTAMP_WINDOW_SEC,
  NONCES_PER_PEER,
  MAX_SOURCE_BUCKETS,
  SOURCE_BURST,
  SOURCE_REFILL_PER_MIN,
  PEER_BURST,
  PEER_REFILL_PER_MIN,
  CONNECT_MIN_INTERVAL_MS,
  CONNECT_JITTER_MAX_MS,
  ACK_TIMEOUT_MS,
  peerSelector,
  buildFreshQuery,
  buildFreshAck,
  buildQueryCanonical,
  computeRequestHash,
  parseQuery,
  parseResponse,
  encodeQuery,
  encodeResponse,
  verifyDoorbellQuery,
  verifyDoorbellAck,
  findPeerBySelector,
  timingSafeSelectorEq,
} from "./peer-doorbell-codec.js";

const TAG = "doorbell";

export type DoorbellRingResult =
  | { status: "acknowledged" }
  | { status: "sent_no_ack" }
  | { status: "unavailable"; reason: string };

export interface PeerConnectionManager {
  ensurePeerConnection(peerName: string, input: {
    reason: "startup" | "udp-doorbell" | "outbox";
    jitterMs?: number;
  }): void;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

interface NonceCacheEntry {
  nonceHex: string;
  expiresAt: number;
}

interface PendingAck {
  queryPacket: Buffer;
  queryCanonical: Buffer;
  peerName: string;
  targetHost: string;
  queryNonceHex: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: DoorbellRingResult) => void;
  reject: (err: Error) => void;
}

function newBucket(burst: number): TokenBucket {
  return { tokens: burst, lastRefill: Date.now() };
}

function refillBucket(b: TokenBucket, ratePerMin: number): void {
  const now = Date.now();
  const elapsedMs = now - b.lastRefill;
  const add = (elapsedMs / 60000) * ratePerMin;
  b.tokens = Math.min(b.tokens + add, ratePerMin);
  b.lastRefill = now;
}

function consumeBucket(b: TokenBucket): boolean {
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export class PeerDoorbellService {
  private socket: Socket | null = null;
  private started = false;
  private localSelector: Buffer = Buffer.alloc(16);
  private peerSelectors = new Map<string, Buffer>();
  private sourceBuckets = new Map<string, { bucket: TokenBucket; expiresAt: number }>();
  private peerBuckets = new Map<string, { bucket: TokenBucket; expiresAt: number }>();
  private nonceCaches = new Map<string, NonceCacheEntry[]>();
  private pendingAcks = new Map<string, PendingAck>();
  private lastPeerConnect = new Map<string, number>();
  private connectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly connectionManager: PeerConnectionManager;
  private collisions: string[] = [];
  private bucketTimer: ReturnType<typeof setInterval> | null = null;

  constructor(connectionManager: PeerConnectionManager) {
    this.connectionManager = connectionManager;
  }

  private rebuildSelectorMaps(): void {
    const config = loadPeerConfig();
    const selfVerifyKey = deriveVerifyKey(config.self.signingKey);
    this.localSelector = Buffer.from(peerSelector(selfVerifyKey));

    this.peerSelectors.clear();
    const seen = new Map<string, string>();
    this.collisions = [];

    for (const [name, entry] of Object.entries(config.peers)) {
      const sel = peerSelector(entry.verifyKey);
      const hex = sel.toString("hex");
      const existing = seen.get(hex);
      if (existing) {
        this.collisions.push(`${existing} and ${name}`);
        continue;
      }
      seen.set(hex, name);
      this.peerSelectors.set(name, sel);
    }

    if (this.collisions.length > 0) {
      logWarn(TAG, `Selector collisions detected: ${this.collisions.join(", ")} — doorbell disabled for colliding peers`);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.rebuildSelectorMaps();

    try {
      this.socket = createSocket({ type: "udp4", reuseAddr: true });
    } catch (err) {
      logWarn(TAG, `Failed to create UDP socket: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    this.socket.on("message", (msg, rinfo) => this.handleMessage(msg, rinfo));
    this.socket.on("error", (err) => logWarn(TAG, `Socket error: ${err.message}`));

    try {
      await new Promise<void>((resolve, reject) => {
        this.socket!.bind(DOORBELL_PORT, "0.0.0.0", () => {
          logInfo(TAG, `Listening on UDP :${DOORBELL_PORT}`);
          resolve();
        });
        this.socket!.once("error", reject);
      });
    } catch (err) {
      logWarn(TAG, `Failed to bind UDP ${DOORBELL_PORT}: ${err instanceof Error ? err.message : String(err)}`);
      this.socket?.close();
      this.socket = null;
      return;
    }

    this.started = true;

    this.bucketTimer = setInterval(() => {
      this.pruneBuckets();
      this.pruneNonceCaches();
    }, 30_000).unref();
  }

  async stop(): Promise<void> {
    this.started = false;

    if (this.bucketTimer) {
      clearInterval(this.bucketTimer);
      this.bucketTimer = null;
    }

    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
      pending.resolve({ status: "unavailable", reason: "service stopped" });
    }
    this.pendingAcks.clear();

    for (const [, timer] of this.connectTimers) {
      clearTimeout(timer);
    }
    this.connectTimers.clear();

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.sourceBuckets.clear();
    this.peerBuckets.clear();
    this.nonceCaches.clear();
    this.lastPeerConnect.clear();
  }

  async ring(peerName: string): Promise<DoorbellRingResult> {
    const config = loadPeerConfig();
    const peer = config.peers[peerName];
    if (!peer) return { status: "unavailable", reason: `unknown peer: ${peerName}` };

    const senderSel = this.localSelector;
    if (senderSel.length !== 16 || senderSel.equals(Buffer.alloc(16))) {
      return { status: "unavailable", reason: "no local sender selector" };
    }

    const targetSel = this.peerSelectors.get(peerName);
    if (!targetSel) {
      return { status: "unavailable", reason: `no selector for peer: ${peerName}` };
    }

    if (!this.socket) return { status: "unavailable", reason: "socket not ready" };

    const query = buildFreshQuery(config.self.signingKey, senderSel, targetSel);
    const queryNonceHex = query.nonce.toString("hex");
    const queryCanonicalBytes = buildQueryCanonical(query);

    const encoded = encodeQuery(query);
    if ("code" in encoded) {
      return { status: "unavailable", reason: `encode failed: ${encoded.code}` };
    }

    return new Promise<DoorbellRingResult>((resolve, reject) => {
      const dnsId = encoded.readUInt16BE(0);

      const pending: PendingAck = {
        queryPacket: encoded,
        queryCanonical: queryCanonicalBytes,
        peerName,
        targetHost: peer.host,
        queryNonceHex,
        timer: setTimeout(() => {
          this.pendingAcks.delete(`${peerName}:${dnsId}`);
          resolve({ status: "sent_no_ack" });
        }, ACK_TIMEOUT_MS),
        resolve,
        reject,
      };

      this.pendingAcks.set(`${peerName}:${dnsId}`, pending);

      this.socket!.send(encoded, 0, encoded.length, DOORBELL_PORT, peer.host, (err) => {
        if (err) {
          clearTimeout(pending.timer);
          this.pendingAcks.delete(`${peerName}:${dnsId}`);
          resolve({ status: "unavailable", reason: `send failed: ${err.message}` });
        }
      });
    });
  }

  private handleMessage(msg: Buffer, rinfo: RemoteInfo): void {
    if (msg.length > MAX_QUERY_BYTES) return;

    const firstBit = (msg.readUInt16BE(2) & 0x8000) !== 0;

    if (firstBit) {
      this.tryProcessResponse(msg, rinfo);
    } else {
      this.tryProcessQuery(msg, rinfo);
    }
  }

  private tryProcessResponse(packet: Buffer, rinfo: RemoteInfo): void {
    const dnsId = packet.readUInt16BE(0);

    for (const [key, pending] of this.pendingAcks) {
      if (!key.startsWith(`${pending.peerName}:${dnsId}`)) continue;

      const parsed = parseResponse(packet, pending.queryPacket);
      if ("code" in parsed) return;

      try {
        const config = loadPeerConfig();
        const peer = config.peers[pending.peerName];
        if (!peer) return;

        // Validate source endpoint
        if (rinfo.address !== peer.host) return;
        if (rinfo.port !== DOORBELL_PORT) return;

        // Validate DNS transaction ID
        if (packet.subarray(0, 2).readUInt16BE(0) !== dnsId) return;

        // Validate responder selector matches the peer we rang
        const expectedResponder = this.peerSelectors.get(pending.peerName);
        if (!expectedResponder || !timingSafeSelectorEq(parsed.ack.responderSelector, expectedResponder)) return;

        // Validate nonce matches the pending query
        if (parsed.ack.requestNonce.toString("hex") !== pending.queryNonceHex) return;

        // Validate request hash
        const expectedHash = computeRequestHash(pending.queryCanonical);
        if (!parsed.ack.requestHash.equals(expectedHash)) return;

        // Validate ack timestamp within window
        const nowSec = Math.floor(Date.now() / 1000);
        if (Number(parsed.ack.timestampSec) < nowSec - TIMESTAMP_WINDOW_SEC) return;
        if (Number(parsed.ack.timestampSec) > nowSec + TIMESTAMP_WINDOW_SEC) return;

        // Verify Ed25519 signature
        if (!verifyDoorbellAck(peer.verifyKey, parsed.ack)) return;

        clearTimeout(pending.timer);
        this.pendingAcks.delete(key);
        pending.resolve({ status: "acknowledged" });
      } catch {
        // invalid ack — ignore
      }
      return;
    }
  }

  private tryProcessQuery(packet: Buffer, rinfo: RemoteInfo): void {
    // Step 1: Cheap source-address token bucket
    if (!this.checkSourceBucket(rinfo.address)) return;

    // Step 2: Strictly parse the DNS envelope and query payload
    const parsed = parseQuery(packet);
    if ("code" in parsed) {
      logTrace(TAG, `Parse error: ${parsed.code}${parsed.detail ? ` (${parsed.detail})` : ""}`);
      return;
    }

    const q = parsed.parsed;

    // Step 3: Constant-time target selector comparison
    if (!timingSafeSelectorEq(q.targetSelector, this.localSelector)) return;

    // Step 4: Find exactly one enrolled peer by sender selector
    const senderName = findPeerBySelector(this.peerSelectors, q.senderSelector);
    if (!senderName) return;

    const config = loadPeerConfig();
    const peerEntry = config.peers[senderName];
    if (!peerEntry?.verifyKey) return;

    // Step 5: Check timestamp window
    const nowSec = Math.floor(Date.now() / 1000);
    if (Number(q.timestampSec) < nowSec - TIMESTAMP_WINDOW_SEC) return;
    if (Number(q.timestampSec) > nowSec + TIMESTAMP_WINDOW_SEC) return;

    // Step 6: Check peer's nonce cache (without recording yet)
    const cache = this.getNonceCache(senderName);
    if (this.isReplayed(cache, q.nonce.toString("hex"))) return;

    // Step 7: Verify Ed25519 signature
    if (!verifyDoorbellQuery(peerEntry.verifyKey, q)) return;

    // Step 8: Enforce authenticated per-peer token bucket
    if (!this.checkPeerBucket(senderName)) return;

    // Step 9: Atomically record nonce as accepted
    this.recordNonce(senderName, q.nonce.toString("hex"));

    // Step 10: Build and send at most one signed acknowledgment
    const queryCanonical = buildQueryCanonical(q);
    const ack = buildFreshAck(config.self.signingKey, this.localSelector, q.nonce, queryCanonical);
    const ackPacket = encodeResponse(packet, ack);
    if (!("code" in ackPacket)) {
      this.socket?.send(ackPacket, 0, ackPacket.length, rinfo.port, rinfo.address, (err) => {
        if (err) logTrace(TAG, `Ack send failed: ${err.message}`);
      });
    }

    // Step 11: Submit coalesced jittered WSS ensure request
    this.ensurePeerDoorbellConnect(senderName);
  }

  private checkSourceBucket(ip: string): boolean {
    const now = Date.now();
    let entry = this.sourceBuckets.get(ip);
    if (!entry) {
      if (this.sourceBuckets.size >= MAX_SOURCE_BUCKETS) {
        const oldest = this.sourceBuckets.entries().next();
        if (oldest.value) this.sourceBuckets.delete(oldest.value[0]);
      }
      entry = { bucket: newBucket(SOURCE_BURST), expiresAt: now + 60_000 };
      this.sourceBuckets.set(ip, entry);
    }
    refillBucket(entry.bucket, SOURCE_REFILL_PER_MIN);
    return consumeBucket(entry.bucket);
  }

  private checkPeerBucket(peerName: string): boolean {
    const now = Date.now();
    let entry = this.peerBuckets.get(peerName);
    if (!entry) {
      entry = { bucket: newBucket(PEER_BURST), expiresAt: now + 60_000 };
      this.peerBuckets.set(peerName, entry);
    }
    refillBucket(entry.bucket, PEER_REFILL_PER_MIN);
    return consumeBucket(entry.bucket);
  }

  private getNonceCache(peerName: string): NonceCacheEntry[] {
    let cache = this.nonceCaches.get(peerName);
    if (!cache) {
      cache = [];
      this.nonceCaches.set(peerName, cache);
    }
    return cache;
  }

  private isReplayed(cache: NonceCacheEntry[], nonceHex: string): boolean {
    const now = Date.now();
    for (const entry of cache) {
      if (entry.nonceHex === nonceHex && now < entry.expiresAt) return true;
    }
    return false;
  }

  private recordNonce(peerName: string, nonceHex: string): void {
    const cache = this.getNonceCache(peerName);
    cache.push({ nonceHex, expiresAt: Date.now() + TIMESTAMP_WINDOW_SEC * 1000 });
    while (cache.length > NONCES_PER_PEER) cache.shift();
  }

  private ensurePeerDoorbellConnect(peerName: string): void {
    const now = Date.now();
    const last = this.lastPeerConnect.get(peerName) ?? 0;

    if (now - last < CONNECT_MIN_INTERVAL_MS) return;

    if (this.connectTimers.has(peerName)) return;

    const jitter = Math.floor(Math.random() * CONNECT_JITTER_MAX_MS);
    const timer = setTimeout(() => {
      this.connectTimers.delete(peerName);
      this.lastPeerConnect.set(peerName, Date.now());
      try {
        this.connectionManager.ensurePeerConnection(peerName, {
          reason: "udp-doorbell",
          jitterMs: 0,
        });
      } catch {
        // best effort
      }
    }, jitter);

    this.connectTimers.set(peerName, timer);
  }

  private pruneBuckets(): void {
    const now = Date.now();
    for (const [key, entry] of this.sourceBuckets) {
      if (now > entry.expiresAt) this.sourceBuckets.delete(key);
    }
    for (const [key, entry] of this.peerBuckets) {
      if (now > entry.expiresAt) this.peerBuckets.delete(key);
    }
  }

  private pruneNonceCaches(): void {
    const now = Date.now();
    for (const [peer, cache] of this.nonceCaches) {
      this.nonceCaches.set(peer, cache.filter(e => now < e.expiresAt));
      if (this.nonceCaches.get(peer)!.length === 0) this.nonceCaches.delete(peer);
    }
  }

  get isRunning(): boolean {
    return this.started && this.socket !== null;
  }
}
