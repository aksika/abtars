/**
 * peer-transport/http-transport.ts — HTTP implementation of PeerTransport (#911).
 *
 * Wraps existing peer-client.ts (JWT auth, TLS, Ed25519 signing) behind the
 * PeerTransport interface. discover() reads peers.json (static).
 */

import type { PeerTransport, PeerCard, PeerMessage, TaskResult } from "./interface.js";
import { getAlivePeers } from "./gossip.js";
import { loadPeerConfig, type PeerEntry } from "../peer-config.js";
import { logInfo, logDebug, logTrace } from "../logger.js";
import type { WsPeerClient } from "./ws-peer-client.js";

const TAG = "http-transport";

export class HttpTransport implements PeerTransport {
  private handlers: Array<(from: string, message: PeerMessage) => void> = [];
  private wsClients = new Map<string, WsPeerClient>();

  /** Init WS connections for all ws-outbound peers. Call on boot. */
  async initWsConnections(): Promise<void> {
    const config = loadPeerConfig();
    const { WsPeerClient: Client } = await import("./ws-peer-client.js");
    for (const [name, entry] of Object.entries(config.peers)) {
      if (entry.transport !== "ws-outbound") continue;
      const client = new Client(name, entry);
      client.onPush((method, payload) => {
        for (const h of this.handlers) h(name, { type: method as any, payload: payload as any });
      });
      client.connect();
      this.wsClients.set(name, client);
      logInfo(TAG, `WS outbound: connecting to ${name}`);
    }
  }

  /** Check if a peer is reachable via WS. */
  hasWsConnection(peer: string): boolean {
    return this.wsClients.get(peer)?.connected ?? false;
  }

  /** Send via WS if available, otherwise fall back to HTTP. */
  private async wsOrHttp(peer: string, method: string, payload: unknown, httpFallback: () => Promise<unknown>): Promise<unknown> {
    const ws = this.wsClients.get(peer);
    if (ws?.connected) {
      return ws.send(method, payload);
    }
    return httpFallback();
  }

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
      const payload: Record<string, unknown> = { task_id: message.payload.task_id, status: message.payload.status, result_summary: message.payload.result_summary, error: message.payload.error };
      if (message.payload.artifacts) payload.artifacts = message.payload.artifacts;
      const body = JSON.stringify(payload);
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

  async delegateTask(peer: string, goal: string, opts?: { priority?: string; context?: string; artifacts?: Array<{ name: string; content: string }> }): Promise<{ taskId: number; remoteSessionId?: string }> {
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);

    // Callback: remote peer looks us up in its peers.json by name

    logDebug(TAG, `→ peer_delegate ${peer}: priority=${opts?.priority ?? "MEDIUM"}, goal=${goal.length}ch`);
    logTrace(TAG, `→ peer_delegate ${peer} goal: ${goal.slice(0, 300)}`);

    // Size guard for artifacts (#928)
    if (opts?.artifacts?.length) {
      const MAX_SINGLE = 1_400_000; // 1.4MB base64 per artifact
      const MAX_TOTAL = 5_000_000;  // 5MB total
      let total = 0;
      for (const a of opts.artifacts) {
        if (a.content.length > MAX_SINGLE) throw new Error(`Artifact '${a.name}' exceeds 1.4MB limit (${a.content.length} bytes)`);
        total += a.content.length;
      }
      if (total > MAX_TOTAL) throw new Error(`Total artifacts exceed 5MB limit (${total} bytes)`);
    }

    const payload: Record<string, unknown> = { goal, priority: opts?.priority ?? "MEDIUM", context: opts?.context, callback_peer: config.self.name };
    if (opts?.artifacts?.length) payload.artifacts = opts.artifacts;

    // #972: Route via WS if connected, otherwise HTTP
    const ws = this.wsClients.get(peer);
    if (ws?.connected) {
      const result = await ws.send("delegate", payload) as any;
      logInfo(TAG, `PEER_DELEGATE ${peer} (ws) → remote#${result.taskId} (${goal.length}ch)`);
      return { taskId: result.taskId, remoteSessionId: result.session_id };
    }

    const body = JSON.stringify(payload);
    const response = await this.httpCall(entry, peer, "POST", "/v1/tasks", body);
    const parsed = JSON.parse(response);
    logInfo(TAG, `PEER_DELEGATE ${peer} → remote#${parsed.task_id} (${goal.length}ch)`);
    return { taskId: parsed.task_id, remoteSessionId: parsed.session_id };
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

  /** #949: Push a channel message to a remote peer. */
  async pushChannelMessage(peer: string, cardId: number, from: string, message: string, createdAt: string): Promise<void> {
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);
    await this.httpCall(entry, peer, "POST", `/v1/tasks/${cardId}/messages`, JSON.stringify({ from_agent: from, message, created_at: createdAt }));
  }

  private async httpCall(entry: PeerEntry, peerName: string, method: string, path: string, body?: string): Promise<string> {
    const { mintPeerJwt, signBody, tlsOptions } = await import("./peer-auth.js");
    const jwt = mintPeerJwt(peerName);
    const finalBody = body ? await signBody(peerName, body) : undefined;
    const tls = tlsOptions(entry);
    const http = await import("node:https");

    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        "Authorization": `Bearer ${jwt}`,
        "Content-Type": "application/json",
      };
      if (finalBody) headers["Content-Length"] = String(Buffer.byteLength(finalBody));

      const req = http.request({
        hostname: entry.host,
        port: entry.port,
        path,
        method,
        headers,
        timeout: 60_000,
        ...tls,
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
