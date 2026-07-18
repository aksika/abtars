/**
 * peer-client.ts — HTTP client for peer_session tool (#392).
 * POST /v1/chat/completions with Ed25519 sig auth + TLS cert verify (#1293).
 */

import { loadPeerConfig, type PeerEntry } from "./peer-config.js";
import { logInfo } from "./logger.js";
import { createPinnedPeerHttpsAgent } from "./peer-transport/pinned-peer-tls.js";

const TAG = "peer-client";

export type PeerError = "timeout" | "unreachable" | "hop_exceeded" | "auth_failed" | "peer_error" | "unknown_peer";

/**
 * Module-level hop budget for the current request. Set by agent-api-server
 * before dispatching a prompt that came with X-Peer-Hops. Read by peer_session
 * tool to know what hops value to forward. Safe in single-threaded Node
 * because agent-api-server processes one prompt at a time per session.
 */
let _currentHops: number | null = null;
export function setCurrentPeerHops(hops: number | null): void { _currentHops = hops; }
export function getCurrentPeerHops(): number | null { return _currentHops; }

export class PeerCallError extends Error {
  constructor(public readonly code: PeerError, message: string) {
    super(message);
    this.name = "PeerCallError";
  }
}

/**
 * Call a peer's /v1/chat/completions endpoint.
 * @param peerName — key in peers.json
 * @param prompt — user message to send
 * @param hops — remaining hop budget (decremented before sending)
 */
export async function callPeer(peerName: string, prompt: string, hops: number, _opts?: { skipWakeup?: boolean }): Promise<string> {
  const config = loadPeerConfig();
  const peerKey = Object.keys(config.peers).find(k => k.toLowerCase() === peerName.toLowerCase());
  const peer = peerKey ? config.peers[peerKey] : undefined;
  if (!peer) {
    const available = Object.keys(config.peers).join(", ") || "(none)";
    throw new PeerCallError("unknown_peer", `Unknown peer '${peerName}'. Available: ${available}`);
  }

  // Sign outgoing message if we have a signing key (#416)
  let signedPrompt = prompt;
  if (config.self.signingKey) {
    const { signMessage } = await import("./digital-signature.js");
    const { tag } = signMessage(config.self.signingKey, config.self.name, peerName, prompt);
    signedPrompt = `${prompt} ${tag}`;
  }

  const start = Date.now();
  try {
    const response = await postCompletion(peer, peerName, signedPrompt, hops, config.timeoutMs, config.self.name);
    logInfo(TAG, `PEER_CALL ${peerName} — ${prompt.length}ch → ${response.length}ch (${Date.now() - start}ms, hops=${hops})`);
    return response;
  } catch (err) {
    throw err;
  }
}

function postCompletion(peer: PeerEntry, peerName: string, prompt: string, hops: number, timeoutMs: number, selfName: string): Promise<string> {
  const { signRequest } = require("./peer-transport/peer-auth.js") as typeof import("./peer-transport/peer-auth.js");
  const { loadPeerConfig } = require("./peer-config.js") as typeof import("./peer-config.js");
  const config = loadPeerConfig();

  const body = JSON.stringify({
    model: "default",
    messages: [{ role: "user", content: prompt }],
  });

  const sigHeaders = signRequest("POST", "/v1/chat/completions", body, config.self.signingKey, selfName);

  const useTls = !!(peer.verifyKey);
  const requestFn = useTls
    ? (require("node:https") as typeof import("node:https")).request
    : require("node:http").request;

  const tlsAgent = useTls ? createPinnedPeerHttpsAgent({ peerName, verifyKey: peer.verifyKey }) : undefined;

  return new Promise((resolve, reject) => {
    const req = requestFn({
      hostname: peer.host,
      port: peer.port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...sigHeaders,
        "X-Peer-Hops": String(hops),
      },
      timeout: timeoutMs,
      ...(useTls ? { minVersion: "TLSv1.3" as const, agent: tlsAgent } : {}),
    } as any, (res: any) => {
      let data = "";
      res.on("data", (c: any) => data += c);
      res.on("end", () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new PeerCallError("auth_failed", `Peer rejected auth (${res.statusCode})`));
          return;
        }
        if (res.statusCode === 429 || res.statusCode === 508) {
          reject(new PeerCallError("hop_exceeded", `Peer refused — hop limit reached`));
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new PeerCallError("peer_error", `Peer returned ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed?.choices?.[0]?.message?.content ?? "";
          resolve(content);
        } catch {
          reject(new PeerCallError("peer_error", `Peer returned non-JSON: ${data.slice(0, 100)}`));
        }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new PeerCallError("timeout", `Peer '${peer.host}:${peer.port}' timed out (${timeoutMs}ms)`)); });
    req.on("error", (err: Error) => reject(new PeerCallError("unreachable", `Peer unreachable: ${err.message}`)));
    req.write(body);
    req.end();
  });
}
