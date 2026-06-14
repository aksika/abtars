/**
 * peer-transport/gossip.ts — Gossip-based peer health (#971).
 *
 * Broadcasts health on every HB tick via UDP. Maintains live peer table.
 * Capabilities auto-discovered at boot. No standalone timer.
 */

import { createSocket, type Socket } from "node:dgram";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import * as os from "node:os";
import { loadPeerConfig } from "../peer-config.js";
import { logInfo, logWarn, logDebug } from "../logger.js";
import type { PeerCard, PeerHealth } from "./interface.js";

const TAG = "gossip";
const GOSSIP_PORT = parseInt(process.env["GOSSIP_PORT"] || "5355", 10);
const TTL_FACTOR = 3; // expire after 3 missed ticks

// ── State ────────────────────────────────────────────────────────────────────

const peerTable = new Map<string, PeerHealth>();
let _socket: Socket | null = null;
let _capabilities: string[] | null = null;
let _hbIntervalMs = 60_000;

// ── Public API ───────────────────────────────────────────────────────────────

/** Start UDP listener. Call once at boot. */
export function startGossipListener(): void {
  if (_socket) return;
  _socket = createSocket("udp4");
  _socket.on("message", handleIncoming);
  _socket.on("error", (err) => logWarn(TAG, `Socket error: ${err.message}`));
  _socket.bind(GOSSIP_PORT, () => {
    logInfo(TAG, `Listening on UDP :${GOSSIP_PORT}`);
  });
}

/** Broadcast our health to all known peers. Registered as HB task. */
export async function gossipBroadcast(): Promise<void> {
  const config = loadPeerConfig();
  if (Object.keys(config.peers).length === 0) return;

  const payload = buildPayload(config.self.name);
  const token = findSelfToken(config);
  const signed = signPayload(payload, token);

  for (const [, entry] of Object.entries(config.peers)) {
    const port = entry.udpPort ?? GOSSIP_PORT;
    sendUdp(entry.host, port, signed);
  }

  expireStale();
}

/** Get live peers (alive only). Falls back to peers.json for non-gossiping peers. */
export function getAlivePeers(): PeerCard[] {
  const config = loadPeerConfig();
  const result: PeerCard[] = [];

  for (const [name, entry] of Object.entries(config.peers)) {
    const health = peerTable.get(name);
    if (health && health.alive) {
      result.push({ name, host: entry.host, port: entry.port, capabilities: health.capabilities });
    } else if (!health) {
      // Peer hasn't gossiped yet — include from static config (backward compat)
      result.push({ name, host: entry.host, port: entry.port, capabilities: entry.allowedTools });
    }
    // If health exists but alive=false — peer is dead, skip
  }
  return result;
}

/** Get full peer table (for /status display). */
export function getPeerTable(): Map<string, PeerHealth> {
  return peerTable;
}

/** Set HB interval (called at boot from heartbeat config). */
export function setGossipInterval(ms: number): void {
  _hbIntervalMs = ms;
}

/** Stop listener (shutdown). */
export function stopGossipListener(): void {
  _socket?.close();
  _socket = null;
}

// ── Internal ─────────────────────────────────────────────────────────────────

function buildPayload(selfName: string): string {
  const caps = getCapabilities();
  const { version } = getVersionInfo();
  return JSON.stringify({
    name: selfName,
    ts: Math.floor(Date.now() / 1000),
    load: Math.round(((os.loadavg()[0] ?? 0) / (os.cpus().length || 1)) * 100) / 100,
    sessions: 0, // TODO: wire spin.listAllSessions().length when available
    capabilities: caps,
    version,
  });
}

function getCapabilities(): string[] {
  if (_capabilities) return _capabilities;
  const caps: string[] = [];
  try { if (existsSync("/usr/bin/docker") || existsSync("/usr/local/bin/docker") || existsSync("/opt/homebrew/bin/docker")) caps.push("browser"); } catch {}
  try { if (existsSync("/usr/bin/xcodebuild") || existsSync("/Applications/Xcode.app")) caps.push("xcode"); } catch {}
  try { if (execSync("nvidia-smi 2>/dev/null", { timeout: 3000 }).length > 0) caps.push("gpu"); } catch {}
  try { if (process.env["OLLAMA_HOST"] || existsSync("/usr/local/bin/ollama") || existsSync("/opt/homebrew/bin/ollama")) caps.push("ollama"); } catch {}
  _capabilities = caps;
  logInfo(TAG, `Capabilities: [${caps.join(", ")}]`);
  return caps;
}

function getVersionInfo(): { version: string } {
  try {
    const pkg = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "../../package.json"), "utf-8"));
    return { version: pkg.version ?? "0.0.0" };
  } catch {
    return { version: "0.0.0" };
  }
}

function signPayload(payload: string, token: string): Buffer {
  const sig = createHmac("sha256", token).update(payload).digest();
  // Format: [32-byte HMAC][payload]
  return Buffer.concat([sig, Buffer.from(payload, "utf-8")]);
}

function verifyAndParse(data: Buffer): { payload: string; name: string } | null {
  if (data.length < 33) return null; // 32 sig + at least 1 byte
  const sig = data.subarray(0, 32);
  const payload = data.subarray(32).toString("utf-8");

  // Parse to get peer name, then verify against their token
  let parsed: { name?: string };
  try { parsed = JSON.parse(payload); } catch { return null; }
  if (!parsed.name) return null;

  const config = loadPeerConfig();
  const peer = config.peers[parsed.name];
  if (!peer) return null;

  const expected = createHmac("sha256", peer.token).update(payload).digest();
  if (!sig.equals(expected)) {
    logDebug(TAG, `HMAC mismatch from ${parsed.name}`);
    return null;
  }
  return { payload, name: parsed.name };
}

function handleIncoming(data: Buffer): void {
  const result = verifyAndParse(data);
  if (!result) return;

  const parsed = JSON.parse(result.payload) as {
    name: string; ts: number; load: number; sessions: number;
    capabilities: string[]; version: string;
  };

  peerTable.set(parsed.name, {
    name: parsed.name,
    lastSeen: Date.now(),
    load: parsed.load,
    sessions: parsed.sessions,
    capabilities: parsed.capabilities ?? [],
    version: parsed.version ?? "?",
    alive: true,
  });

  logDebug(TAG, `← ${parsed.name} load=${parsed.load} caps=[${parsed.capabilities?.join(",")}]`);
}

function expireStale(): void {
  const ttl = _hbIntervalMs * TTL_FACTOR;
  const now = Date.now();
  for (const [, health] of peerTable) {
    health.alive = (now - health.lastSeen) < ttl;
  }
}

function sendUdp(host: string, port: number, data: Buffer): void {
  if (!_socket) return;
  _socket.send(data, 0, data.length, port, host, (err) => {
    if (err) logDebug(TAG, `UDP send to ${host}:${port} failed: ${err.message}`);
  });
}

function findSelfToken(config: ReturnType<typeof loadPeerConfig>): string {
  // Use the first peer's token for HMAC (peers verify against our entry in THEIR peers.json)
  // All peers share the same token for a given pair — use any peer's token as our signing key
  const firstPeer = Object.values(config.peers)[0];
  return firstPeer?.token ?? "default-gossip-key";
}
