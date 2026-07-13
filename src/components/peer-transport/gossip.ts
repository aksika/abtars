/**
 * gossip.ts — Peer health gossip UDP transport (#971, #1293, #1392, #1360).
 *
 * #1360: Uses unified PeerHealthStore for ingestion and broadcast.  No longer
 * owns the peer table, private interval, or synthetic WSS health records.
 * Supports gossip v2 (same payload schema as WSS) alongside legacy v1.
 */

import { createSocket, type Socket } from "node:dgram";
import { loadPeerConfig } from "../peer-config.js";
import { logInfo, logDebug, logWarn, logTrace } from "../logger.js";
import { getHealthStore, buildSignedStatus } from "./peer-health.js";

const TAG = "gossip";
const GOSSIP_PORT = parseInt(process.env["GOSSIP_PORT"] ?? "5355", 10);
const MAX_GOSSIP_PACKET_BYTES = 16 * 1024;

// ── Legacy v1 types ──────────────────────────────────────────────────────────

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

// ── UDP socket ────────────────────────────────────────────────────────────────

let _socket: Socket | null = null;

// ── V1 packet handling (legacy) ───────────────────────────────────────────────

function tryParseGossipV1(data: Buffer): { payload: string; sigBase64: string } | null {
  const str = data.toString("utf8");
  const sepIdx = str.lastIndexOf("|");
  if (sepIdx < 0) return null;
  const payload = str.slice(0, sepIdx);
  const sigBase64 = str.slice(sepIdx + 1);
  if (payload.length === 0 || sigBase64.length === 0) return null;
  return { payload, sigBase64 };
}

function tryParseGossipV2(data: Buffer): { payload: string; sigBase64: string } | null {
  const str = data.toString("utf8");
  const prefix = "abtars-gossip-v2\n";
  if (!str.startsWith(prefix)) return null;
  const sepIdx = str.lastIndexOf("|");
  if (sepIdx < 0) return null;
  const payload = str.slice(prefix.length, sepIdx);
  const sigBase64 = str.slice(sepIdx + 1);
  if (payload.length === 0 || sigBase64.length === 0) return null;
  return { payload, sigBase64 };
}

function routeAcceptedGossipV1(
  payloadStr: string,
  sigBase64: string,
  peerName: string,
  host: string,
  port: number,
): void {
  // Legacy v1 has no epoch/sequence.  Wrap into the v1 schema envelope and
  // let the health store parse it.  v1 is treated as lower-authority legacy
  // observation — can refresh host health but cannot introduce
  // pi-executor/workspace capabilities.
  const store = getHealthStore();
  const parsed = JSON.parse(payloadStr);
  const converted = JSON.stringify({
    version: 1,
    peer: peerName,
    sentAt: parsed.ts,
    epoch: "legacy-v1",
    sequence: 0,
    load: parsed.load,
    sessions: parsed.sessions,
    abtarsVersion: parsed.version ?? "?",
    capabilities: parsed.capabilities?.filter((c: string) =>
      !c.startsWith("pi-") && !c.startsWith("workspace:")
    ) ?? [],
  });
  const envelope = { payload: converted, signature: sigBase64 };
  const result = store.ingestSignedStatus("udp", peerName, envelope);
  if (result.ok) {
    logTrace(TAG, `V1 gossip accepted from ${peerName}`);
  }
}

// ── Packet handling ───────────────────────────────────────────────────────────

function handleUdpPacket(msg: Buffer, rinfo: { address: string; port: number }): void {
  if (msg.length > MAX_GOSSIP_PACKET_BYTES) {
    logTrace(TAG, `Gossip oversized (${msg.length} bytes) from ${rinfo.address}`);
    return;
  }

  // Try v2 first (preferred)
  const v2 = tryParseGossipV2(msg);
  if (v2) {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(v2.payload); } catch { return; }
    const name = typeof parsed.peer === "string" ? parsed.peer : null;
    if (!name) return;

    const store = getHealthStore();
    const envelope = { payload: v2.payload, signature: v2.sigBase64 };
    const result = store.ingestSignedStatus("udp", name, envelope);
    if (!result.ok && result.reason !== "self") {
      logDebug(TAG, `V2 gossip rejected from ${name}: ${result.reason}`);
    }
    return;
  }

  // Try v1 (legacy)
  const v1 = tryParseGossipV1(msg);
  if (!v1) return;

  // Minimal parse to get name for identity check
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(v1.payload); } catch { return; }
  const name = typeof parsed.name === "string" ? parsed.name : null;
  if (!name) return;

  const config = loadPeerConfig();
  if (name === config.self.name) return;

  const peerEntry = config.peers[name];
  if (!peerEntry?.verifyKey) return;

  // Verify v1 Ed25519 signature
  const { verify: cryptoVerify, createPublicKey } = require("node:crypto") as typeof import("node:crypto");
  try {
    const pubKey = createPublicKey({ key: Buffer.from(peerEntry.verifyKey, "base64"), format: "der", type: "spki" });
    const canonical = `abtars-gossip-v1\n${v1.payload}`;
    const ok = cryptoVerify(null, Buffer.from(canonical, "utf-8"), pubKey, Buffer.from(v1.sigBase64, "base64"));
    if (!ok) {
      logTrace(TAG, `V1 gossip bad signature from ${name}`);
      return;
    }
  } catch {
    return;
  }

  routeAcceptedGossipV1(v1.payload, v1.sigBase64, name, rinfo.address, rinfo.port);
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Register capabilities from the host environment. */
function registerHostCapabilities(): void {
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  const store = getHealthStore();
  const caps: string[] = ["bash", "node", "memory"];
  try { if (execSync("which docker", { stdio: "pipe" }).toString().trim()) caps.push("docker"); } catch {}
  try { if (execSync("which xcodebuild", { stdio: "pipe" }).toString().trim()) caps.push("xcode"); } catch {}
  try { if (execSync("which ollama", { stdio: "pipe" }).toString().trim()) caps.push("ollama"); } catch {}
  if (existsSync("/usr/bin/nvidia-smi") || process.env["CUDA_VISIBLE_DEVICES"]) caps.push("gpu");
  if (process.env["BROWSER_ENGINE"]) caps.push("browser");
  if (process.env["GROQ_API_KEY"]) caps.push("stt");
  store.capabilities.register("host", caps);
}

/** Start gossip UDP listener. No longer starts its own broadcast interval — heartbeat owns that. */
export function startGossip(): void {
  registerHostCapabilities();
  _socket = createSocket("udp4");
  _socket.on("message", handleUdpPacket);
  _socket.on("error", (err) => { logWarn(TAG, `Socket error: ${err.message}`); });
  _socket.bind(GOSSIP_PORT, "0.0.0.0", () => {
    logInfo(TAG, `Listening on UDP :${GOSSIP_PORT}`);
  });
}

/** Stop gossip. */
export function stopGossip(): void {
  if (_socket) { _socket.close(); _socket = null; }
}

/** Broadcast current signed status over UDP to all peers. Called by heartbeat. */
export function gossipBroadcast(): void {
  const config = loadPeerConfig();
  const store = getHealthStore();
  const signed = buildSignedStatus(config.self.signingKey);
  const v2Packet = Buffer.from(`abtars-gossip-v2\n${signed.payload}|${signed.signature}`);

  for (const [name, entry] of Object.entries(config.peers)) {
    _socket?.send(v2Packet, 0, v2Packet.length, GOSSIP_PORT, entry.host, (err) => {
      if (err) logTrace(TAG, `Send to ${name} (${entry.host}:${GOSSIP_PORT}) failed: ${err.message}`);
    });
  }
  logTrace(TAG, `Gossip broadcast to ${Object.keys(config.peers).length} peer(s)`);

  try {
    const { updateBridgeLockField } = require("../transport/bridge-lock-transport.js") as typeof import("../transport/bridge-lock-transport.js");
    updateBridgeLockField("lastGossipBroadcast", Date.now());
  } catch { /* lock unavailable */ }

  store.expireStale();
}

/** Delegate to health store (redirect from legacy API). */
export function getPeerTable(includeAll = false): PeerHealth[] {
  return getHealthStore().getPeerTable(includeAll).map(p => ({
    name: p.name,
    lastSeen: p.lastSeen,
    load: p.load,
    sessions: p.sessions,
    capabilities: p.capabilities,
    version: p.version,
    alive: p.alive,
    host: p.host,
    port: p.port,
  }));
}

export function getAlivePeers(): PeerHealth[] {
  return getPeerTable(false);
}

export function findCapablePeer(requires: string[]): PeerHealth | null {
  return getHealthStore().findCapablePeer(requires) ?? null;
}

export function getLocalCapabilities(): string[] {
  return getHealthStore().capabilities.getValues();
}

export function setGossipInterval(_ms: number): void {
  // No-op: gossip no longer owns an interval.
  // Heartbeat drives broadcast timing.
}

export const startGossipListener = startGossip;
export const stopGossipListener = stopGossip;
