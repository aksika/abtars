/**
 * gossip.ts — Peer health gossip (#971).
 *
 * Each peer broadcasts liveness + load + capabilities every 60s via UDP.
 * All peers maintain a live peer table (Map with 90s TTL).
 * Orc reads this table for intelligent routing.
 */

import { createSocket, type Socket } from "node:dgram";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { loadPeerConfig } from "../peer-config.js";
import { logInfo, logDebug, logWarn, logTrace } from "../logger.js";
import { createHmac } from "node:crypto";

const TAG = "gossip";
const GOSSIP_PORT = parseInt(process.env["GOSSIP_PORT"] ?? "5355", 10);
const BROADCAST_INTERVAL_MS = 60_000;
const TTL_MS = 180_000; // 3 missed broadcasts → dead

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

/** Get normalized system load (0-1). */
function getLoad(): number {
  const cores = cpus().length || 1;
  return Math.min(1, loadavg()[0]! / cores);
}

/** Build the gossip packet. */
function getGossipKey(config: ReturnType<typeof loadPeerConfig>): string | null {
  if (config.gossipSecret) return config.gossipSecret as string;
  return null;
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
  const key = getGossipKey(config) ?? Object.values(config.peers)[0]?.token ?? "default";
  const sig = createHmac("sha256", key).update(payload).digest("base64url").slice(0, 16);
  return Buffer.from(`${payload}|${sig}`);
}

/** Verify incoming packet HMAC. */
function verifyPacket(data: Buffer): Record<string, unknown> | null {
  const str = data.toString("utf8");
  const sepIdx = str.lastIndexOf("|");
  if (sepIdx < 0) return null;
  const payload = str.slice(0, sepIdx);
  const sig = str.slice(sepIdx + 1);
  const config = loadPeerConfig();
  // Prefer shared gossipSecret
  const shared = getGossipKey(config);
  if (shared) {
    const expected = createHmac("sha256", shared).update(payload).digest("base64url").slice(0, 16);
    if (sig === expected) { try { return JSON.parse(payload); } catch { return null; } }
    return null;
  }
  // Fallback: try all peer tokens
  for (const peer of Object.values(config.peers)) {
    const key = peer.token;
    if (!key) continue;
    const expected = createHmac("sha256", key).update(payload).digest("base64url").slice(0, 16);
    if (sig === expected) { try { return JSON.parse(payload); } catch { return null; } }
  }
  return null;
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
  // Expire stale entries
  const now = Date.now();
  for (const [, health] of peerTable) {
    const wasAlive = health.alive;
    health.alive = (now - health.lastSeen) < TTL_MS;
    if (wasAlive && !health.alive) logDebug(TAG, `PEER_OFFLINE ${health.name} (no heartbeat for ${Math.round((now - health.lastSeen) / 1000)}s)`);
  }
}

/** Start gossip system. */
export function startGossip(): void {
  _capabilities = discoverCapabilities();
  logInfo(TAG, `Capabilities: [${_capabilities.join(", ")}]`);

  _socket = createSocket("udp4");
  _socket.on("message", (msg, rinfo) => {
    const parsed = verifyPacket(msg);
    if (!parsed || typeof parsed.name !== "string") return;
    const name = parsed.name as string;
    const config = loadPeerConfig();

    // Ping/pong: reply with signed PONG, skip peer-table update
    if (parsed.type === "ping") {
      const key = getGossipKey(config) ?? Object.values(config.peers)[0]?.token ?? "default";
      const pong = "PONG";
      const sig = createHmac("sha256", key).update(pong).digest("base64url").slice(0, 16);
      const reply = Buffer.from(`${pong}|${sig}`);
      _socket?.send(reply, 0, reply.length, rinfo.port, rinfo.address);
      return;
    }

    if (name === config.self.name) return; // ignore own echo

    const existing = peerTable.get(name);
    const health: PeerHealth = {
      name,
      lastSeen: Date.now(),
      load: (parsed.load as number) ?? 0,
      sessions: (parsed.sessions as number) ?? 0,
      capabilities: (parsed.capabilities as string[]) ?? [],
      version: (parsed.version as string) ?? "?",
      alive: true,
      host: rinfo.address,
      port: rinfo.port,
    };
    peerTable.set(name, health);
    if (!existing) logDebug(TAG, `PEER_ONLINE ${name} [${health.capabilities.join(",")}] v${health.version}`);
    else if (!existing.alive) logDebug(TAG, `PEER_ONLINE ${name} returned [${health.capabilities.join(",")}] v${health.version}`);
  });

  _socket.on("error", (err) => { logWarn(TAG, `Socket error: ${err.message}`); });
  _socket.bind(GOSSIP_PORT, "0.0.0.0", () => {
    logInfo(TAG, `Listening on UDP :${GOSSIP_PORT}`);
  });

  // Broadcast immediately, then every 60s
  setTimeout(broadcast, 2000);
  _interval = setInterval(broadcast, BROADCAST_INTERVAL_MS);
}

/** Stop gossip. */
export function stopGossip(): void {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_socket) { _socket.close(); _socket = null; }
}

/** Get live peer table (alive peers only unless includeAll). */
export function getPeerTable(includeAll = false): PeerHealth[] {
  const now = Date.now();
  const results: PeerHealth[] = [];
  for (const health of peerTable.values()) {
    health.alive = (now - health.lastSeen) < TTL_MS;
    if (includeAll || health.alive) results.push(health);
  }
  return results;
}

/** Get this peer's capabilities. */
export function getLocalCapabilities(): string[] { return _capabilities; }

/** Find best peer matching required capabilities, sorted by load. */
export function findCapablePeer(requires: string[]): PeerHealth | null {
  const alive = getPeerTable().filter(p =>
    requires.every(req => p.capabilities.includes(req))
  );
  if (alive.length === 0) return null;
  alive.sort((a, b) => a.load - b.load);
  return alive[0]!;
}

/** Alias for boot compatibility. */
export const startGossipListener = startGossip;

/** Alias for http-transport compatibility. */
export const getAlivePeers = getPeerTable;

/** Alias for phase-heartbeat compatibility. */
export const gossipBroadcast = broadcast;

/** Alias: update broadcast interval (resets the internal timer). */
export function setGossipInterval(ms: number): void {
  if (_interval) { clearInterval(_interval); _interval = setInterval(broadcast, ms); }
}

/** Alias for stopGossip. */
export const stopGossipListener = stopGossip;
