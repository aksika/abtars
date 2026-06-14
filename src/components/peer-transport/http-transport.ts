/**
 * peer-transport/http-transport.ts — HTTP implementation of PeerTransport (#911).
 *
 * Wraps existing peer-client.ts (JWT auth, TLS, Ed25519 signing) behind the
 * PeerTransport interface. discover() reads peers.json (static).
 */

import type { PeerTransport, PeerCard, PeerMessage, TaskResult } from "./interface.js";
import { getAlivePeers } from "./gossip.js";
import { loadPeerConfig, type PeerEntry } from "../peer-config.js";
import { logInfo, logWarn, logDebug, logTrace } from "../logger.js";

const TAG = "http-transport";

export class HttpTransport implements PeerTransport {
  private handlers: Array<(from: string, message: PeerMessage) => void> = [];

  discover(): PeerCard[] {
    return getAlivePeers();
  }

  async send(peer: string, message: PeerMessage): Promise<unknown> {
    if (message.type === "ask") {
      const { callPeer } = await import("../peer-client.js");
      const config = loadPeerConfig();
      return callPeer(peer, message.payload.prompt as string, config.maxHops);
    }
    if (message.type === "task" && message.payload.action === "callback") {
      const config = loadPeerConfig();
      const entry = resolvePeer(config.peers, peer);
      logDebug(TAG, `→ callback ${peer}: task_id=${message.payload.task_id} status=${message.payload.status}`);
      logTrace(TAG, `→ callback ${peer} result: ${String(message.payload.result_summary ?? "").slice(0, 200)}`);
      const body = JSON.stringify({ task_id: message.payload.task_id, status: message.payload.status, result_summary: message.payload.result_summary, error: message.payload.error });
      return this.httpCall(entry, peer, "POST", "/v1/callbacks", body);
    }
    if (message.type === "task") return this.delegateTask(peer, message.payload.goal as string, message.payload as any);
    if (message.type === "check") return this.checkTask(peer, message.payload.taskId as number);
    if (message.type === "terminate") return this.terminateTask(peer, message.payload.taskId as number);
    throw new Error(`Unknown message type: ${message.type}`);
  }

  async broadcast(message: PeerMessage): Promise<void> {
    const peers = this.discover();
    await Promise.allSettled(peers.map(p => this.send(p.name, message)));
  }

  onMessage(handler: (from: string, message: PeerMessage) => void): void {
    this.handlers.push(handler);
  }

  /** Called by agent-api-server when an inbound peer message arrives. */
  dispatchInbound(from: string, message: PeerMessage): void {
    for (const h of this.handlers) { try { h(from, message); } catch {} }
  }

  async delegateTask(peer: string, goal: string, opts?: { priority?: string; context?: string }): Promise<number> {
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);

    // Construct callback URL from our own agent-api port
    const selfPort = parseInt(process.env["AGENT_API_PORT"] || "3100", 10);
    const selfHost = entry.host; // peer knows us by the host they connect to — use their entry's perspective
    // Actually: we don't know our own external IP. Include callback as our self.name — remote looks us up in its peers.json
    const callbackUrl = `callback://${config.self.name}`;

    logDebug(TAG, `→ peer_delegate ${peer}: priority=${opts?.priority ?? "MEDIUM"}, goal=${goal.length}ch`);
    logTrace(TAG, `→ peer_delegate ${peer} goal: ${goal.slice(0, 300)}`);

    const body = JSON.stringify({ goal, priority: opts?.priority ?? "MEDIUM", context: opts?.context, callback_peer: config.self.name });
    const response = await this.httpCall(entry, peer, "POST", "/v1/tasks", body);
    const parsed = JSON.parse(response);
    logInfo(TAG, `PEER_DELEGATE ${peer} → remote#${parsed.task_id} (${goal.length}ch)`);
    return parsed.task_id;
  }

  async checkTask(peer: string, taskId: number): Promise<TaskResult> {
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);
    logDebug(TAG, `→ peer_check ${peer}#${taskId}`);
    const response = await this.httpCall(entry, peer, "GET", `/v1/tasks/${taskId}`);
    const parsed = JSON.parse(response);
    logDebug(TAG, `← peer_check ${peer}#${taskId}: status=${parsed.status}`);
    logTrace(TAG, `← peer_check ${peer}#${taskId} result: ${(parsed.result_summary ?? "").slice(0, 200)}`);
    return {
      taskId: parsed.id ?? taskId,
      status: parsed.status,
      result: parsed.result_summary,
      error: parsed.error,
      tokensUsed: parsed.tokens_used,
    };
  }

  async terminateTask(peer: string, taskId: number): Promise<void> {
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);
    logDebug(TAG, `→ peer_terminate ${peer}#${taskId}`);
    await this.httpCall(entry, peer, "DELETE", `/v1/tasks/${taskId}`);
    logInfo(TAG, `PEER_TERMINATE ${peer}#${taskId}`);
  }

  private async httpCall(entry: PeerEntry, peerName: string, method: string, path: string, body?: string): Promise<string> {
    const { signJwt } = await import("../peer-jwt.js");
    const config = loadPeerConfig();
    const now = Math.floor(Date.now() / 1000);
    const jwt = signJwt({ iss: config.self.name, aud: peerName, iat: now, exp: now + 60 }, entry.token);

    // Sign body content if signingKey configured
    let finalBody = body;
    if (body && config.self.signingKey) {
      const { signMessage } = await import("../digital-signature.js");
      const { tag } = signMessage(config.self.signingKey, config.self.name, peerName, body);
      const parsed = JSON.parse(body);
      parsed._sig = tag;
      finalBody = JSON.stringify(parsed);
    }

    const useTls = !!(entry.certFingerprint || entry.certPem);
    const http = useTls ? await import("node:https") : await import("node:http");

    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        "Authorization": `Bearer ${jwt}`,
        "Content-Type": "application/json",
      };
      if (finalBody) headers["Content-Length"] = String(Buffer.byteLength(finalBody));

      const tlsOpts = useTls ? {
        minVersion: "TLSv1.3" as const,
        rejectUnauthorized: true,
        ...(entry.certPem ? { ca: [entry.certPem] } : {}),
        checkServerIdentity: (_host: string, cert: { fingerprint256?: string }) => {
          if (entry.certFingerprint && cert.fingerprint256 !== entry.certFingerprint) {
            return new Error(`Cert fingerprint mismatch`);
          }
          return undefined;
        },
      } : {};

      const req = http.request({
        hostname: entry.host,
        port: entry.port,
        path,
        method,
        headers,
        timeout: 60_000,
        ...tlsOpts,
      } as any, (res: any) => {
        let data = "";
        res.on("data", (c: any) => data += c);
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`Peer ${peerName} returned ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          resolve(data);
        });
      });
      req.on("timeout", () => { req.destroy(); reject(new Error(`Peer ${peerName} timeout`)); });
      req.on("error", (err: Error) => reject(new Error(`Peer ${peerName} unreachable: ${err.message}`)));
      if (finalBody) req.write(finalBody);
      req.end();
    });
  }
}

function resolvePeer(peers: Record<string, PeerEntry>, name: string): PeerEntry {
  const key = Object.keys(peers).find(k => k.toLowerCase() === name.toLowerCase());
  if (!key || !peers[key]) throw new Error(`Unknown peer '${name}'. Available: ${Object.keys(peers).join(", ")}`);
  return peers[key];
}
