/**
 * peer-transport/http-transport.ts — HTTP implementation of PeerTransport (#911).
 *
 * Wraps existing peer-client.ts (JWT auth, TLS, Ed25519 signing) behind the
 * PeerTransport interface. discover() reads peers.json (static).
 */

import type { PeerTransport, PeerCard, PeerMessage, TaskResult, PeerDelegateResult } from "./interface.js";
import { getAlivePeers } from "./gossip.js";
import { loadPeerConfig, type PeerEntry } from "../peer-config.js";
import { logInfo, logDebug, logTrace } from "../logger.js";
import type { WsPeerClient } from "./ws-peer-client.js";
import { createPinnedPeerHttpsAgent } from "./pinned-peer-tls.js";

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
        if (method === "peer-status.v1") {
          // #1360: Ingest signed peer status — ephemeral health update
          const envelope = payload as { payload: string; signature: string };
          if (envelope && typeof envelope.payload === "string" && typeof envelope.signature === "string") {
            import("./peer-health.js").then(({ getHealthStore }) => {
              getHealthStore().ingestSignedStatus("wss", name, envelope);
            }).catch(() => {});
          }
          return;
        }
        if (method === "pi.lifecycle.v1") {
          // #1358: Owner pushed a lifecycle event to us (origin side)
          import("./remote-pi-registry.js").then(({ getRemotePiOriginReducer }) => {
            const reducer = getRemotePiOriginReducer();
            if (!reducer) return; // not configured
            import("../peer-config.js").then(({ loadPeerConfig }) => {
              const localPeerName = loadPeerConfig().self.name;
              import("./remote-pi-agent-api-integration.js").then(({ handlePushLifecycleEvent }) => {
                handlePushLifecycleEvent({ originReducer: reducer, localPeerName }, name, payload as any).catch(() => {});
              }).catch(() => {});
            }).catch(() => {});
          }).catch(() => {});
          return;
        }
        if (method === "callback") {
          // Inbound callback from peer — fire as if it arrived via HTTP /v1/callbacks
          const p = payload as { task_id: number; status: string; result_summary?: string; error?: string; tokens_used?: number };
          import("../tasks/kanban-board.js").then(({ kanbanList, kanbanComplete, kanbanFail, kanbanAddTokens }) => {
            const cards = kanbanList("running", "status").filter(c => {
              if (c.type !== "remote") return false;
              try { const m = JSON.parse(c.notes ?? "{}"); return m.peer === name && m.remote_task_id === p.task_id; } catch { return false; }
            });
            if (!cards.length) return;
            const card = cards[0]!;
            if (p.tokens_used) kanbanAddTokens(card.id, p.tokens_used);
            if (p.status === "done") kanbanComplete(card.id, null, p.result_summary ?? "");
            else kanbanFail(card.id, p.error ?? "remote failure");
            import("../nerve.js").then(({ nerve }) => nerve.emit(p.status === "done" ? "card:done" : "card:failed", card.id));
          }).catch(() => {});
        } else if (method === "channel") {
          // Inbound channel message from peer
          const p = payload as { card_id: number; from_agent: string; message: string; created_at: string };
          import("../tasks/kanban-channel.js").then(({ channelPost }) => {
            channelPost(p.card_id, p.from_agent, "ALL", p.message);
          }).catch(() => {});
        }
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

  /** #1360: Broadcast signed status to all connected WSS peers. */
  broadcastStatus(): void {
    const { loadPeerConfig } = require("../peer-config.js");
    const { buildSignedStatus } = require("./peer-health.js");
    const config = loadPeerConfig();
    const signed = buildSignedStatus(config.self.signingKey);
    for (const [name, client] of this.wsClients) {
      if (client.connected) {
        try {
          (client as any).sendPush("peer-status.v1", signed);
        } catch { /* skip failed peer */ }
      }
    }
  }

  /** #1293 — Called by HB tick to check and reconnect stale ws-outbound connections. */
  checkWsConnections(): void {
    for (const [name, client] of this.wsClients) {
      if (!client.connected) {
        logDebug(TAG, `HB: ws-outbound ${name} disconnected — scheduling reconnect`);
        client.connect();
      }
    }
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

      // #972: Push via WS if connected
      const ws = this.wsClients.get(peer);
      if (ws?.connected) {
        await ws.send("callback", payload);
        logInfo(TAG, `CALLBACK ${peer} (ws) task_id=${message.payload.task_id}`);
        return;
      }

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

  async delegateTask(peer: string, goal: string, opts?: { priority?: string; context?: string; artifacts?: Array<{ name: string; content: string }>; contract?: Record<string, unknown>; attemptId?: string; target?: import("./interface.js").RemotePiTargetV1; requestId?: string }): Promise<PeerDelegateResult> {
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);

    const kind = opts?.target?.executor === "pi" ? "pi" : "agent";
    logDebug(TAG, `→ peer_delegate ${peer} kind=${kind} priority=${opts?.priority ?? "MEDIUM"}, goal=${goal.length}ch`);
    logTrace(TAG, `→ peer_delegate ${peer} goal: ${goal.slice(0, 300)}`);

    if (opts?.artifacts?.length) {
      const MAX_SINGLE = 1_400_000;
      const MAX_TOTAL = 5_000_000;
      let total = 0;
      for (const a of opts.artifacts) {
        if (a.content.length > MAX_SINGLE) throw new Error(`Artifact '${a.name}' exceeds 1.4MB limit (${a.content.length} bytes)`);
        total += a.content.length;
      }
      if (total > MAX_TOTAL) throw new Error(`Total artifacts exceed 5MB limit (${total} bytes)`);
    }

    const payload: Record<string, unknown> = { goal, priority: opts?.priority ?? "MEDIUM", context: opts?.context, callback_peer: config.self.name };
    if (opts?.artifacts?.length) payload.artifacts = opts.artifacts;
    if (opts?.contract) payload.worker_contract = opts.contract;
    if (opts?.attemptId) payload.attempt_id = opts.attemptId;
    if (opts?.target) payload.target = opts.target;
    if (opts?.requestId) payload.request_id = opts.requestId;

    const ws = this.wsClients.get(peer);
    if (ws?.connected) {
      const result = await ws.send("delegate", payload) as any;
      logInfo(TAG, `PEER_DELEGATE ${peer} (ws) → remote#${result.taskId} (${goal.length}ch)`);
      return { taskId: result.taskId, remoteSessionId: result.session_id, runId: result.run_id, generation: result.generation, executor: result.executor };
    }

    const body = JSON.stringify(payload);
    const response = await this.httpCall(entry, peer, "POST", "/v1/tasks", body);
    const parsed = JSON.parse(response);
    logInfo(TAG, `PEER_DELEGATE ${peer} → remote#${parsed.task_id} (${goal.length}ch) executor=${parsed.executor ?? "agent"}`);
    return { taskId: parsed.task_id, remoteSessionId: parsed.session_id, runId: parsed.run_id, generation: parsed.generation, executor: parsed.executor ?? "agent" };
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

  // #1358 — Remote Pi lifecycle and control implementations

  async pushLifecycleEvent(peer: string, event: unknown): Promise<void> {
    const ws = this.wsClients.get(peer);
    if (ws?.connected) {
      ws.sendPush("pi.lifecycle.v1", event);
      logTrace(TAG, `Pushed lifecycle event to ${peer}`);
      return;
    }
    // Fallback to HTTPS push endpoint
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);
    await this.httpCall(entry, peer, "POST", "/v1/pi-events/push", JSON.stringify(event));
  }

  async listRemotePiEvents(peer: string, request: unknown): Promise<unknown> {
    const ws = this.wsClients.get(peer);
    if (ws?.connected) {
      return await ws.call("pi.events.list.v1", request);
    }
    // Fallback to HTTPS. Build the query string with URLSearchParams so
    // values are properly encoded — run_id is a UUID-like string with no
    // special characters, but the encoder keeps this safe for future
    // input shapes (e.g. encoded run references).
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);
    const req = request as { run_id: string; after_sequence: number; limit?: number };
    const params = new URLSearchParams();
    params.set("after_sequence", String(req.after_sequence));
    if (req.limit !== undefined) params.set("limit", String(req.limit));
    const response = await this.httpCall(
      entry, peer, "GET",
      `/v1/pi-runs/${encodeURIComponent(req.run_id)}/events?${params.toString()}`,
    );
    return JSON.parse(response);
  }

  async acknowledgeRemotePiEvents(peer: string, request: unknown): Promise<unknown> {
    const ws = this.wsClients.get(peer);
    if (ws?.connected) {
      return await ws.call("pi.events.ack.v1", request);
    }
    // Fallback to HTTPS
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);
    const response = await this.httpCall(entry, peer, "POST", `/v1/pi-runs/${(request as any).run_id}/events/acknowledge`, JSON.stringify(request));
    return JSON.parse(response);
  }

  async sendRemotePiControl(peer: string, request: unknown): Promise<unknown> {
    const ws = this.wsClients.get(peer);
    if (ws?.connected) {
      return await ws.call("pi.control.v1", request);
    }
    // Fallback to HTTPS
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);
    const response = await this.httpCall(entry, peer, "POST", `/v1/pi-runs/${(request as any).run_id}/control`, JSON.stringify(request));
    return JSON.parse(response);
  }

  private async httpCall(entry: PeerEntry, peerName: string, method: string, path: string, body?: string): Promise<string> {
    const { signRequest } = await import("./peer-auth.js");
    const { loadPeerConfig } = await import("../peer-config.js");
    const config = loadPeerConfig();

    if (!entry.verifyKey) {
      throw new Error(`Peer ${peerName} has no verifyKey — enroll first before calling`);
    }

    const bodyStr = body ?? "";
    const sigHeaders = signRequest(method, path, bodyStr, config.self.signingKey, config.self.name);

    const http = await import("node:https");
    const agent = createPinnedPeerHttpsAgent({ peerName, verifyKey: entry.verifyKey });

    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        ...sigHeaders,
        "Content-Type": "application/json",
      };
      if (body) headers["Content-Length"] = String(Buffer.byteLength(body));

      const req = http.request({
        hostname: entry.host,
        port: entry.port,
        path,
        method,
        headers,
        timeout: 60_000,
        minVersion: "TLSv1.3" as const,
        agent,
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
      if (body) req.write(body);
      req.end();
    });
  }
}

function resolvePeer(peers: Record<string, PeerEntry>, name: string): PeerEntry {
  const key = Object.keys(peers).find(k => k.toLowerCase() === name.toLowerCase());
  if (!key || !peers[key]) throw new Error(`Unknown peer '${name}'. Available: ${Object.keys(peers).join(", ")}`);
  return peers[key];
}
