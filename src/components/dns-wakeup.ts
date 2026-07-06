/**
 * dns-wakeup.ts — mDNS-disguised UDP wake-up for A2A callback (#425).
 *
 * Sender crafts a valid mDNS PTR query: AB-<token>._workstation._tcp.local
 * Token = (ts(4) + nonce(1)) XOR HMAC-SHA256(peer.token, peername)[:5]
 *
 * Receiver tries each known peer, XORs to recover ts, validates within 60s.
 * On valid wake-up → triggers A2A callback (outbound TCP).
 *
 * Looks like normal mDNS service discovery to endpoint protection.
 */

import { createSocket, type Socket } from "node:dgram";
import { createHmac, randomBytes } from "node:crypto";
import { logInfo, logWarn, logDebug } from "./logger.js";
import type { PeerConfig } from "./peer-config.js";

const TAG = "dns-wakeup";
const PREFIX = "ab-";
const SUFFIX = "._workstation._tcp.local";
const PATTERN = /^ab-([a-f0-9]{10})\._workstation\._tcp\.local$/;
const MAX_AGE_S = 60;
const RATE_LIMIT_MS = 5000;

const lastWakeup = new Map<string, number>();

/** Parse the query name from a raw DNS/mDNS packet (minimal parser). */
function parseMdnsQueryName(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  let offset = 12; // skip DNS header
  const labels: string[] = [];
  while (offset < buf.length) {
    const len = buf[offset]!;
    if (len === 0) break;
    if (len > 63) return null; // compressed — not expected in queries
    offset++;
    if (offset + len > buf.length) return null;
    labels.push(buf.subarray(offset, offset + len).toString("ascii"));
    offset += len;
  }
  return labels.join(".").toLowerCase();
}

/** Build a minimal mDNS query packet for a PTR record. */
function buildMdnsQuery(name: string): Buffer {
  const labels = name.split(".");
  // Header: ID=0, flags=0 (standard query), QDCOUNT=1
  const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  // Question section: labels + null + type PTR (12) + class IN (1)
  const parts: Buffer[] = [header];
  for (const label of labels) {
    parts.push(Buffer.from([label.length]));
    parts.push(Buffer.from(label, "ascii"));
  }
  parts.push(Buffer.from([0])); // root label
  parts.push(Buffer.from([0, 12, 0, 1])); // type PTR, class IN
  return Buffer.concat(parts);
}

/** Build an empty mDNS response (no answers — looks like "not found"). */
function buildEmptyResponse(queryBuf: Buffer): Buffer {
  const resp = Buffer.from(queryBuf);
  // Set QR=1 (response), RCODE=0 in flags
  if (resp.length >= 4) {
    resp[2] = 0x84; // QR=1, AA=1
    resp[3] = 0x00; // RCODE=0
  }
  return resp;
}

export function startDnsWakeup(
  port: number,
  config: PeerConfig,
  onWakeup: (peerName: string) => void,
): Socket {
  const sock = createSocket("udp4");

  sock.on("message", (msg, rinfo) => {
    const name = parseMdnsQueryName(msg);
    if (!name || !PATTERN.test(name)) return; // early bail — not ours

    const token10 = name.match(PATTERN)![1]!;
    const tokenBuf = Buffer.from(token10, "hex"); // 5 bytes

    for (const [peerName, peer] of Object.entries(config.peers)) {
      // #1293: PeerEntry no longer has .token — DNS wakeup is unsupported in Ed25519 model
      // The receiver path is kept for future use but will never match without a token
      const peerToken = (peer as Record<string, unknown>)["token"] as string | undefined;
      if (!peerToken) continue;
      const hmac = createHmac("sha256", peerToken).update(peerName).digest();
      const decoded = Buffer.alloc(5);
      for (let i = 0; i < 5; i++) decoded[i] = tokenBuf[i]! ^ hmac[i]!;
      const ts = decoded.readUInt32BE(0);
      // decoded[4] = nonce — discarded

      if (Math.abs(Date.now() / 1000 - ts) <= MAX_AGE_S) {
        // Rate limit
        const now = Date.now();
        const last = lastWakeup.get(peerName) ?? 0;
        if (now - last < RATE_LIMIT_MS) {
          logDebug(TAG, `Rate-limited wake-up from ${peerName}`);
          return;
        }
        lastWakeup.set(peerName, now);

        // Send empty mDNS response
        sock.send(buildEmptyResponse(msg), rinfo.port, rinfo.address);

        logInfo(TAG, `Valid wake-up from ${peerName} — initiating callback`);
        onWakeup(peerName);
        return;
      }
    }
  });

  sock.on("error", (err) => logWarn(TAG, `Socket error: ${err.message}`));
  sock.bind(port, () => logInfo(TAG, `Listening on UDP port ${port}`));
  return sock;
}

/** Send a wake-up signal to a peer (mDNS-disguised). Skips if no token available. */
export function sendWakeup(peerName: string, peerHost: string, udpPort: number, _token?: string): void {
  // #1293: PeerEntry no longer has a token field. Wake-up via peer.token is removed.
  // DNS wakeup is a best-effort legacy feature; with Ed25519 auth there is no per-peer token.
  logWarn(TAG, `sendWakeup: token-based wakeup not supported in Ed25519 auth model (#1293) — skipping ${peerName}`);
}
