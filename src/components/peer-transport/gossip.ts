/**
 * gossip.ts — Peer health gossip (#971, #1293, #1392).
 *
 * #1392: Added typed schema validation, freshness window, timestamp watermark,
 * packet fingerprint cache, and isolated health ingestion.  No rejected packet
 * can mutate peer table or replay state.
 */

import { createSocket, type Socket } from "node:dgram";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { createHash } from "node:crypto";
import { loadPeerConfig } from "../peer-config.js";
import { logInfo, logDebug, logWarn, logTrace } from "../logger.js";

const TAG = "gossip";
const GOSSIP_PORT = parseInt(process.env["GOSSIP_PORT"] ?? "5355", 10);
const BROADCAST_INTERVAL_MS = 60_000;
const TTL_MS = 180_000;

// #1392 — bounds and freshness
const MAX_GOSSIP_PACKET_BYTES = 16 * 1024;
const MAX_PEER_NAME_CHARS = 128;
const MAX_VERSION_CHARS = 64;
const MAX_CAPABILITIES = 64;
const MAX_CAPABILITY_CHARS = 64;
const MAX_SESSIONS = 10_000;
const MAX_PAST_AGE_SEC = 90;
const MAX_FUTURE_SKEW_SEC = 30;
const MAX_FINGERPRINTS_PER_PEER = 8;

// ── Types ──────────────────────────────────────────────────────────────────

export interface PeerHealth {
  name: string;
  lastSeen: number;
  load: number;
  sessions: number;
  capabilities: string[];
  version: string;
  alive: boolean;
  host: string;
  port: number;
}

interface GossipPayloadV1 {
  name: string;
  ts: number;
  load: number;
  sessions: number;
  capabilities: string[];
  version: string;
}

type GossipRejectReason =
  | "oversized" | "bad_envelope" | "bad_json" | "bad_schema"
  | "self" | "unknown_peer" | "bad_signature"
  | "stale" | "future" | "replay" | "out_of_order";

type GossipValidation =
  | { ok: true; payload: GossipPayloadV1; name: string }
  | { ok: false; reason: GossipRejectReason; peer?: string };

// ── Replay guard ───────────────────────────────────────────────────────────

interface PeerFreshness {
  lastAcceptedTs: number;
  fingerprints: Map<string, number>;  // fingerprint → local expiry ms
}

const freshnessMap = new Map<string, PeerFreshness>();

function getFreshness(peer: string): PeerFreshness {
  let f = freshnessMap.get(peer);
  if (!f) { f = { lastAcceptedTs: 0, fingerprints: new Map() }; freshnessMap.set(peer, f); }
  return f;
}

/** #1392 — Check freshness gates without mutating state (caller commits on success). */
function checkFreshness(
  peer: string, ts: number, fingerprint: string, nowSec: number,
): { ok: true } | { ok: false; reason: GossipRejectReason } {
  if (ts < nowSec - MAX_PAST_AGE_SEC) return { ok: false, reason: "stale" };
  if (ts > nowSec + MAX_FUTURE_SKEW_SEC) return { ok: false, reason: "future" };

  const f = getFreshness(peer);

  // Expire old fingerprints
  const cutoff = Date.now() + TTL_MS;
  for (const [fp, expiry] of f.fingerprints) {
    if (expiry < cutoff) f.fingerprints.delete(fp);
  }

  if (f.fingerprints.has(fingerprint)) return { ok: false, reason: "replay" };
  if (ts <= f.lastAcceptedTs) return { ok: false, reason: "out_of_order" };

  return { ok: true };
}

function commitFreshness(peer: string, ts: number, fingerprint: string): void {
  const f = getFreshness(peer);
  f.lastAcceptedTs = ts;
  f.fingerprints.set(fingerprint, Date.now() + TTL_MS);
  if (f.fingerprints.size > MAX_FINGERPRINTS_PER_PEER) {
    const oldest = f.fingerprints.entries().next();
    if (oldest.value) f.fingerprints.delete(oldest.value[0]);
  }
}

/** Prune freshness state for peers no longer configured. */
function pruneFreshness(): void {
  const config = loadPeerConfig();
  for (const peer of freshnessMap.keys()) {
    if (!config.peers[peer]) freshnessMap.delete(peer);
  }
}

// ── Schema validation ──────────────────────────────────────────────────────

function isValidCapability(cap: string): boolean {
  return typeof cap === "string" && cap.length > 0 && cap.length <= MAX_CAPABILITY_CHARS && /^[A-Za-z0-9_.\-]+$/.test(cap);
}

/** #1392 — Validate the typed V1 schema after signature verification. */
function validateSchema(parsed: Record<string, unknown>): GossipPayloadV1 {
  const name = parsed.name;
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_PEER_NAME_CHARS) throw new Error("bad_schema");

  const ts = parsed.ts;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0 || !Number.isSafeInteger(ts)) throw new Error("bad_schema");

  const load = parsed.load;
  if (typeof load !== "number" || !Number.isFinite(load) || load < 0 || load > 1) throw new Error("bad_schema");

  const sessions = parsed.sessions;
  if (typeof sessions !== "number" || !Number.isFinite(sessions) || sessions < 0 || sessions > MAX_SESSIONS || !Number.isSafeInteger(sessions)) throw new Error("bad_schema");

  const capabilities = parsed.capabilities;
  if (!Array.isArray(capabilities)) throw new Error("bad_schema");
  if (capabilities.length > MAX_CAPABILITIES) throw new Error("bad_schema");
  const seen = new Set<string>();
  for (const cap of capabilities) {
    if (typeof cap !== "string" || !isValidCapability(cap)) throw new Error("bad_schema");
    if (seen.has(cap)) throw new Error("bad_schema");
    seen.add(cap);
  }

  const version = parsed.version;
  if (typeof version !== "string" || version.length > MAX_VERSION_CHARS) throw new Error("bad_schema");

  return { name, ts, load, sessions, capabilities: [...capabilities], version };
}

// ── Packet validation pipeline ─────────────────────────────────────────────

/** #1392 — Pure validator: returns typed accepted/rejected result. No side effects. */
function validatePacket(data: Buffer): GossipValidation {
  // 1. Byte-size bound
  if (data.length > MAX_GOSSIP_PACKET_BYTES) return { ok: false, reason: "oversized" };

  const str = data.toString("utf8");
  const sepIdx = str.lastIndexOf("|");
  if (sepIdx < 0) return { ok: false, reason: "bad_envelope" };

  const payload = str.slice(0, sepIdx);
  const sigBase64 = str.slice(sepIdx + 1);
  if (payload.length === 0 || sigBase64.length === 0) return { ok: false, reason: "bad_envelope" };

  // 2. Minimal parse to get name
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(payload); } catch { return { ok: false, reason: "bad_json" }; }
  if (typeof parsed.name !== "string") return { ok: false, reason: "bad_schema" };

  const config = loadPeerConfig();
  const name = parsed.name;

  if (name === config.self.name) return { ok: false, reason: "self" };

  const peerEntry = config.peers[name];
  if (!peerEntry?.verifyKey) return { ok: false, reason: "unknown_peer", peer: name };

  // 3. Ed25519 signature verify over exact payload bytes
  const { verify: cryptoVerify, createPublicKey } = require("node:crypto") as typeof import("node:crypto");
  try {
    const pubKey = createPublicKey({ key: Buffer.from(peerEntry.verifyKey, "base64"), format: "der", type: "spki" });
    const canonical = `abtars-gossip-v1\n${payload}`;
    const ok = cryptoVerify(null, Buffer.from(canonical, "utf-8"), pubKey, Buffer.from(sigBase64, "base64"));
    if (!ok) return { ok: false, reason: "bad_signature", peer: name };
  } catch {
    return { ok: false, reason: "bad_signature", peer: name };
  }

  // 4. Full schema validation
  let typed: GossipPayloadV1;
  try { typed = validateSchema(parsed); } catch { return { ok: false, reason: "bad_schema", peer: name }; }

  // 5. Freshness + replay
  const fingerprint = createHash("sha256").update(data).digest("hex");
  const nowSec = Math.floor(Date.now() / 1000);
  const fresh = checkFreshness(name, typed.ts, fingerprint, nowSec);
  if (!fresh.ok) return { ok: false, reason: fresh.reason, peer: name };

  return { ok: true, payload: typed, name };
}

// ── Health ingestion (only from accepted packets) ──────────────────────────

/** #1392 — Update peer table from a validated packet. Never called for rejected packets. */
function ingestAcceptedGossip(payload: GossipPayloadV1, fingerprint: string, host: string, port: number, receivedAtMs: number): void {
  commitFreshness(payload.name, payload.ts, fingerprint);

  const existing = peerTable.get(payload.name);
  const health: PeerHealth = {
    name: payload.name,
    lastSeen: receivedAtMs,
    load: payload.load,
    sessions: payload.sessions,
    capabilities: payload.capabilities,
    version: payload.version,
    alive: true,
    host,
    port,
  };
  peerTable.set(payload.name, health);
  if (!existing) logDebug(TAG, `PEER_ONLINE ${payload.name} [${health.capabilities.join(",")}] v${health.version}`);
  else if (!existing.alive) logDebug(TAG, `PEER_ONLINE ${payload.name} returned [${health.capabilities.join(",")}] v${health.version}`);
}

// ── Outgoing broadcast ─────────────────────────────────────────────────────

const peerTable = new Map<string, PeerHealth>();
let _socket: Socket | null = null;
let _interval: ReturnType<typeof setInterval> | null = null;
let _capabilities: string[] = [];

/** Auto-discover this peer's capabilities at boot. */
function discoverCapabilities(): string[] {
  const caps: string[] = ["bash", "node", "memory"];
  try { if (execSync("which docker", { stdio: "pipe" }).toString().trim()) caps.push("docker"); } catch {}
  try { if (execSync("which xcodebuild", { stdio: "pipe" }).toString().trim()) caps.push("xcode"); } catch {}
  try { if (execSync("which ollama", { stdio: "pipe" }).toString().trim()) caps.push("ollama"); } catch {}
  if (existsSync("/usr/bin/nvidia-smi") || process.env["CUDA_VISIBLE_DEVICES"]) caps.push("gpu");
  if (process.env["BROWSER_ENGINE"]) caps.push("browser");
  if (process.env["GROQ_API_KEY"]) caps.push("stt");
  return caps;
}

function getLoad(): number {
  const cores = cpus().length || 1;
  return Math.min(1, loadavg()[0]! / cores);
}

function buildPacket(): Buffer {
  const config = loadPeerConfig();
  const payload = JSON.stringify({
    name: config.self.name,
    ts: Math.floor(Date.now() / 1000),
    load: Math.round(getLoad() * 100) / 100,
    sessions: parseInt(process.env["_ACTIVE_SESSIONS"] ?? "0", 10),
    capabilities: _capabilities,
    version: process.env["npm_package_version"] ?? "?",
  });
  const { sign: cryptoSign, createPrivateKey } = require("node:crypto") as typeof import("node:crypto");
  const privKey = createPrivateKey({ key: Buffer.from(config.self.signingKey, "base64"), format: "der", type: "pkcs8" });
  const canonical = `abtars-gossip-v1\n${payload}`;
  const sig = cryptoSign(null, Buffer.from(canonical, "utf-8"), privKey).toString("base64");
  return Buffer.from(`${payload}|${sig}`);
}

/** Broadcast to all known peers. */
function broadcast(): void {
  const config = loadPeerConfig();
  const packet = buildPacket();
  for (const [name, entry] of Object.entries(config.peers)) {
    _socket?.send(packet, 0, packet.length, GOSSIP_PORT, entry.host, (err) => {
      if (err) logTrace(TAG, `Send to ${name} (${entry.host}:${GOSSIP_PORT}) failed: ${err.message}`);
    });
  }
  logTrace(TAG, `Broadcast to ${Object.keys(config.peers).length} peer(s)`);
  try {
    const { updateBridgeLockField } = require("../transport/bridge-lock-transport.js") as typeof import("../transport/bridge-lock-transport.js");
    updateBridgeLockField("lastGossipBroadcast", Date.now());
  } catch { /* lock unavailable */ }
  // Expire stale entries based on TTL
  const now = Date.now();
  for (const [, health] of peerTable) {
    const wasAlive = health.alive;
    health.alive = (now - health.lastSeen) < TTL_MS;
    if (wasAlive && !health.alive) logDebug(TAG, `PEER_OFFLINE ${health.name} (no heartbeat for ${Math.round((now - health.lastSeen) / 1000)}s)`);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Start gossip system. */
export function startGossip(): void {
  _capabilities = discoverCapabilities();
  logInfo(TAG, `Capabilities: [${_capabilities.join(", ")}]`);

  _socket = createSocket("udp4");
  _socket.on("message", (msg, rinfo) => {
    const result = validatePacket(msg);

    if (!result.ok) {
      // Rejected packets never mutate peer table or freshness state.
      // Log at trace/debug level, throttle for replay floods.
      if (result.reason === "bad_signature" || result.reason === "stale" || result.reason === "future") {
        logDebug(TAG, `Gossip rejected from ${result.peer ?? "?"}: ${result.reason}`);
      }
      return;
    }

    ingestAcceptedGossip(result.payload, createHash("sha256").update(msg).digest("hex"), rinfo.address, rinfo.port, Date.now());
  });

  _socket.on("error", (err) => { logWarn(TAG, `Socket error: ${err.message}`); });
  _socket.bind(GOSSIP_PORT, "0.0.0.0", () => {
    logInfo(TAG, `Listening on UDP :${GOSSIP_PORT}`);
  });

  setTimeout(broadcast, 2000);
  _interval = setInterval(broadcast, BROADCAST_INTERVAL_MS);
}

/** Stop gossip. */
export function stopGossip(): void {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_socket) { _socket.close(); _socket = null; }
}

/** Get live peer table. Also marks ws-outbound peers alive from WSS (separate from gossip freshness). */
export function getPeerTable(includeAll = false): PeerHealth[] {
  pruneFreshness();
  const now = Date.now();

  // WSS liveness is a separate signal from gossip freshness
  try {
    const { getPeerTransport } = require("./index.js") as typeof import("./index.js");
    const transport = getPeerTransport() as import("./http-transport.js").HttpTransport;
    const { loadPeerConfig } = require("../peer-config.js") as typeof import("../peer-config.js");
    const config = loadPeerConfig();
    for (const [name, entry] of Object.entries(config.peers)) {
      if (entry.transport === "ws-outbound" && typeof transport.hasWsConnection === "function" && transport.hasWsConnection(name)) {
        const existing = peerTable.get(name);
        if (!existing) {
          peerTable.set(name, {
            name, lastSeen: now, load: 0, sessions: 0, capabilities: [], version: "?", alive: true, host: entry.host, port: entry.port,
          });
        } else {
          existing.lastSeen = now;
          existing.alive = true;
        }
      }
    }
  } catch { /* best effort */ }

  const results: PeerHealth[] = [];
  for (const health of peerTable.values()) {
    health.alive = (now - health.lastSeen) < TTL_MS;
    if (includeAll || health.alive) results.push(health);
  }
  return results;
}

export function getLocalCapabilities(): string[] { return _capabilities; }

export function findCapablePeer(requires: string[]): PeerHealth | null {
  const alive = getPeerTable().filter(p =>
    requires.every(req => p.capabilities.includes(req))
  );
  if (alive.length === 0) return null;
  alive.sort((a, b) => a.load - b.load);
  return alive[0]!;
}

export const startGossipListener = startGossip;
export const getAlivePeers = getPeerTable;
export const gossipBroadcast = broadcast;

export function setGossipInterval(ms: number): void {
  if (_interval) { clearInterval(_interval); _interval = setInterval(broadcast, ms); }
}

export const stopGossipListener = stopGossip;
