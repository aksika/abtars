import type { PeerTransport, PeerCard, PeerMessage } from "./interface.js";
import type { PeerHelpRequestV1, PeerHelpResponseV1, PeerHelpStatusRequestV1, PeerHelpStatusV1, PeerHelpWithdrawV1 } from "../peer-help/contract.js";
import type { RemotePiEventsListRequestV1, RemotePiEventsListResponseV1, RemotePiEventsAckRequestV1, RemotePiEventsAckResponseV1, RemotePiControlRequestV1, RemotePiControlResponseV1 } from "./remote-pi-types.js";
import { loadPeerConfig, type PeerEntry } from "../peer-config.js";
import { logInfo, logDebug } from "../logger.js";
import type { WsPeerClient } from "./ws-peer-client.js";
import { createPinnedPeerHttpsAgent } from "./pinned-peer-tls.js";
import { getPeerWsBroker } from "./peer-ws-broker.js";
import { PeerDoorbellService, type DoorbellRingResult } from "./peer-doorbell.js";
import { CONNECT_JITTER_MAX_MS } from "./peer-doorbell-codec.js";

const TAG = "http-transport";

export class HttpTransport implements PeerTransport {
  private handlers: Array<(from: string, message: PeerMessage) => void> = [];
  private wsClients = new Map<string, WsPeerClient>();
  private doorbell: PeerDoorbellService | null = null;

  /** Set the doorbell service instance for peer wakeup. */
  setDoorbell(doorbell: PeerDoorbellService): void {
    this.doorbell = doorbell;
  }

  /** Ring a peer via doorbell. */
  async ringDoorbell(peerName: string): Promise<DoorbellRingResult> {
    if (!this.doorbell) return { status: "unavailable", reason: "doorbell not configured" };
    return this.doorbell.ring(peerName);
  }

  /** Ensure a peer WSS connection exists or is being established. */
  ensurePeerConnection(peerName: string, input: {
    reason: "startup" | "heartbeat" | "udp-doorbell" | "outbox";
    jitterMs?: number;
  }): void {
    const existing = this.wsClients.get(peerName);
    if (existing?.connected) return;
    if (existing && !existing.connected) return; // connecting/reconnecting — coalesce

    const config = loadPeerConfig();
    const entry = config.peers[peerName];
    if (!entry || entry.transport !== "ws-outbound") return;

    const jitter = input.jitterMs ?? Math.floor(Math.random() * CONNECT_JITTER_MAX_MS);
    setTimeout(() => {
      const { WsPeerClient: Client } = require("./ws-peer-client.js") as typeof import("./ws-peer-client.js");
      if (this.wsClients.has(peerName)) return;
      const client = new Client(peerName, entry);
      this.setupWsClient(peerName, client);
      client.connect();
      this.wsClients.set(peerName, client);
      logInfo(TAG, `WS doorbell: connecting to ${peerName} (reason: ${input.reason})`);
    }, jitter).unref();
  }

  async initWsConnections(): Promise<void> {
    const config = loadPeerConfig();
    const { WsPeerClient: Client } = await import("./ws-peer-client.js");
    for (const [name, entry] of Object.entries(config.peers)) {
      if (entry.transport !== "ws-outbound") continue;
      const client = new Client(name, entry);
      this.setupWsClient(name, client);
      client.connect();
      this.wsClients.set(name, client);
      logInfo(TAG, `WS outbound: connecting to ${name}`);
    }
  }

  private setupWsClient(peerName: string, client: WsPeerClient): void {
    client.onPush((method: string, payload: unknown) => {
      if (method === "peer.inventory.v1") {
        const { verifyAndStoreInventory } = require("./peer-inventory.js") as typeof import("./peer-inventory.js");
        const config = loadPeerConfig();
        const peerEntry = config.peers[peerName];
        if (peerEntry?.verifyKey) {
          verifyAndStoreInventory(peerName, payload as any, peerEntry.verifyKey);
        }
        return;
      }
      if (method === "pi.lifecycle.v1") {
        import("./remote-pi-registry.js").then(({ getRemotePiOriginReducer }) => {
          const reducer = getRemotePiOriginReducer();
          if (!reducer) return;
          import("../peer-config.js").then(({ loadPeerConfig }) => {
            const localPeerName = loadPeerConfig().self.name;
            import("./remote-pi-agent-api-integration.js").then(({ handlePushLifecycleEvent }) => {
              handlePushLifecycleEvent({ originReducer: reducer, localPeerName }, peerName, payload as any).catch(() => {});
            }).catch(() => {});
          }).catch(() => {});
        }).catch(() => {});
        return;
      }
      if (method === "callback") {
        const p = payload as { task_id: number; status: string; result_summary?: string; error?: string; tokens_used?: number };
        import("../tasks/kanban-board.js").then(({ kanbanList, kanbanComplete, kanbanFail, kanbanAddTokens }) => {
          const cards = kanbanList("running", "status").filter(c => {
            if (c.type !== "remote") return false;
            try { const m = JSON.parse(c.notes ?? "{}"); return m.peer === peerName && m.remote_task_id === p.task_id; } catch { return false; }
          });
          if (!cards.length) return;
          const card = cards[0]!;
          if (p.tokens_used) kanbanAddTokens(card.id, p.tokens_used);
          if (p.status === "done") kanbanComplete(card.id, null, p.result_summary ?? "");
          else kanbanFail(card.id, p.error ?? "remote failure");
          import("../nerve.js").then(({ nerve }) => nerve.emit(p.status === "done" ? "card:done" : "card:failed", card.id));
        }).catch(() => {});
      } else if (method === "channel") {
        const p = payload as { card_id: number; from_agent: string; message: string; created_at: string };
        import("../tasks/kanban-channel.js").then(({ channelPost }) => {
          channelPost(p.card_id, p.from_agent, "ALL", p.message);
        }).catch(() => {});
      }
      for (const h of this.handlers) h(peerName, { type: method as any, payload: payload as any });
    });
  }

  hasWsConnection(peer: string): boolean {
    return this.wsClients.get(peer)?.connected ?? false;
  }

  broadcastInventory(): void {
    try {
      const { loadPeerConfig } = require("../peer-config.js") as typeof import("../peer-config.js");
      const { buildSignedInventory } = require("./peer-inventory.js") as typeof import("./peer-inventory.js");
      const { getLocalCapabilities } = require("./peer-health.js") as typeof import("./peer-health.js");
      const config = loadPeerConfig();
      const payload = buildSignedInventory(
        config.self.signingKey,
        config.self.name,
        process.env["npm_package_version"] ?? "0.0.0",
        getLocalCapabilities(),
        ["wss", "https"],
      );
      const broker = getPeerWsBroker();
      broker.pushToAll("peer.inventory.v1", payload);
    } catch { /* best effort */ }
  }

  checkWsConnections(): void {
    for (const [name, client] of this.wsClients) {
      if (!client.connected) {
        logDebug(TAG, `HB: ws-outbound ${name} disconnected — scheduling reconnect`);
        client.connect();
      }
    }
  }

  discover(): PeerCard[] {
    const config = loadPeerConfig();
    return Object.entries(config.peers).map(([name, entry]) => ({
      name,
      host: entry.host,
      port: entry.port,
    }));
  }

  async send(peer: string, message: PeerMessage): Promise<unknown> {
    if (message.type === "ask") {
      const { callPeer } = await import("../peer-client.js");
      const config = loadPeerConfig();
      return callPeer(peer, message.payload.prompt as string, config.maxHops);
    }
    if (message.type === "callback") {
      const config = loadPeerConfig();
      const entry = resolvePeer(config.peers, peer);
      logDebug(TAG, `→ callback ${peer}: task_id=${message.payload.task_id}`);
      const payload: Record<string, unknown> = { task_id: message.payload.task_id, status: message.payload.status, result_summary: message.payload.result_summary, error: message.payload.error };
      const ws = this.wsClients.get(peer);
      if (ws?.connected) {
        await ws.send("callback", payload);
        return;
      }
      const body = JSON.stringify(payload);
      return this.httpCall(entry, peer, "POST", "/v1/callbacks", body);
    }
    if (message.type === "channel") return this.pushChannelMessage(peer, message.payload.cardId as number, message.payload.from as string, message.payload.message as string, message.payload.createdAt as string);
    throw new Error(`Unknown message type: ${message.type}`);
  }

  async broadcast(message: PeerMessage): Promise<void> {
    const peers = this.discover();
    await Promise.allSettled(peers.map(p => this.send(p.name, message)));
  }

  onMessage(handler: (from: string, message: PeerMessage) => void): void {
    this.handlers.push(handler);
  }

  dispatchInbound(from: string, message: PeerMessage): void {
    for (const h of this.handlers) { try { h(from, message); } catch {} }
  }

  // ── Peer Help Transport ──────────────────────────────────────────────────

  async askHelp(peer: string, request: PeerHelpRequestV1): Promise<PeerHelpResponseV1> {
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);
    const { parseHelpResponse } = await import("../peer-help/contract.js");

    const payload: Record<string, unknown> = { ...request as any };

    const ws = this.wsClients.get(peer);
    if (ws?.connected) {
      const result = await ws.send("help.request.v1", payload) as any;
      const parsed = parseHelpResponse(result);
      if (!parsed.ok) throw new Error(`Invalid help response: ${parsed.error}`);
      return parsed.value;
    }

    const body = JSON.stringify(payload);
    const response = await this.httpCall(entry, peer, "POST", "/v1/help/requests", body);
    const parsed = parseHelpResponse(JSON.parse(response));
    if (!parsed.ok) throw new Error(`Invalid help response: ${parsed.error}`);
    return parsed.value;
  }

  async getHelpStatus(peer: string, request: PeerHelpStatusRequestV1): Promise<PeerHelpStatusV1> {
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);
    const { parseHelpStatus } = await import("../peer-help/contract.js");

    const ws = this.wsClients.get(peer);
    if (ws?.connected) {
      const result = await ws.send("help.status.v1", request) as any;
      if (result.error) throw new Error(String(result.error));
      const parsed = parseHelpStatus(result);
      if (!parsed.ok) throw new Error(`Invalid status response: ${parsed.error}`);
      return parsed.value;
    }

    const params = new URLSearchParams({ contribution_ref: request.contribution_ref });
    const response = await this.httpCall(entry, peer, "GET", `/v1/help/requests/${encodeURIComponent(request.request_id)}?${params.toString()}`);
    const parsed = parseHelpStatus(JSON.parse(response));
    if (!parsed.ok) throw new Error(`Invalid status response: ${parsed.error}`);
    return parsed.value;
  }

  async withdrawHelp(peer: string, request: PeerHelpWithdrawV1): Promise<{ acknowledged: boolean; owner_action?: string }> {
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);

    const ws = this.wsClients.get(peer);
    if (ws?.connected) {
      return await ws.send("help.withdraw.v1", request) as any;
    }

    const body = JSON.stringify(request);
    const response = await this.httpCall(entry, peer, "POST", `/v1/help/requests/${encodeURIComponent(request.request_id)}/withdraw`, body);
    return JSON.parse(response);
  }

  async pushChannelMessage(peer: string, cardId: number, from: string, message: string, createdAt: string): Promise<void> {
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);
    await this.httpCall(entry, peer, "POST", `/v1/tasks/${cardId}/messages`, JSON.stringify({ from_agent: from, message, created_at: createdAt }));
    return;
  }

  deliverHelpEvent(peer: string, event: unknown): Promise<void> {
    const ws = this.wsClients.get(peer);
    if (ws?.connected) {
      return ws.send("help.event.v1", event).then(() => {}) as Promise<void>;
    }
    return Promise.resolve();
  }

  // ── Remote Pi ────────────────────────────────────────────────────────────

  async pushLifecycleEvent(peer: string, event: unknown): Promise<void> {
    const ws = this.wsClients.get(peer);
    if (ws?.connected) {
      ws.sendPush("pi.lifecycle.v1", event);
      return;
    }
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);
    await this.httpCall(entry, peer, "POST", "/v1/pi-events/push", JSON.stringify(event));
  }

  async listRemotePiEvents(peer: string, request: RemotePiEventsListRequestV1): Promise<RemotePiEventsListResponseV1> {
    const ws = this.wsClients.get(peer);
    if (ws?.connected) {
      return await ws.call("pi.events.list.v1", request);
    }
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);
    const req = request;
    const params = new URLSearchParams();
    params.set("after_sequence", String(req.after_sequence));
    if (req.limit !== undefined) params.set("limit", String(req.limit));
    const response = await this.httpCall(
      entry, peer, "GET",
      `/v1/pi-runs/${encodeURIComponent(req.run_id)}/events?${params.toString()}`,
    );
    return JSON.parse(response) as RemotePiEventsListResponseV1;
  }

  async acknowledgeRemotePiEvents(peer: string, request: RemotePiEventsAckRequestV1): Promise<RemotePiEventsAckResponseV1> {
    const ws = this.wsClients.get(peer);
    if (ws?.connected) {
      return await ws.call("pi.events.ack.v1", request);
    }
    const config = loadPeerConfig();
    const entry = resolvePeer(config.peers, peer);
    const response = await this.httpCall(entry, peer, "POST", `/v1/pi-runs/${request.run_id}/events/acknowledge`, JSON.stringify(request));
    return JSON.parse(response) as RemotePiEventsAckResponseV1;
  }

  async sendRemotePiControl(peer: string, request: RemotePiControlRequestV1): Promise<RemotePiControlResponseV1> {
    const ws = this.wsClients.get(peer);
    if (ws?.connected) {
      return await ws.call("pi.control.v1", request);
    }
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
