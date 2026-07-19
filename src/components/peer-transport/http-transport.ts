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
  private routeUnsubscribe: (() => void) | null = null;
  private capabilityUnsubscribe: (() => void) | null = null;

  /** Set the doorbell service instance for peer wakeup. */
  setDoorbell(doorbell: PeerDoorbellService): void {
    this.doorbell = doorbell;
  }

  /** Ring a peer via doorbell. */
  async ringDoorbell(peerName: string): Promise<DoorbellRingResult> {
    if (!this.doorbell) return { status: "unavailable", reason: "doorbell not configured" };
    return this.doorbell.ring(peerName);
  }

  /** Start route and capability subscriptions. Called after initWsConnections. */
  start(): void {
    if (this.routeUnsubscribe) return;
    const broker = getPeerWsBroker();
    this.routeUnsubscribe = broker.subscribeRoutes((event) => {
      if (event.type === "available") {
        this.onRouteAvailable(event.peer);
      }
    });

    const { getHealthStore } = require("./peer-health.js") as typeof import("./peer-health.js");
    const store = getHealthStore();
    this.capabilityUnsubscribe = store.subscribe(() => {
      this.broadcastInventory();
    });
  }

  /** Stop route and capability subscriptions. */
  stop(): void {
    if (this.routeUnsubscribe) {
      this.routeUnsubscribe();
      this.routeUnsubscribe = null;
    }
    if (this.capabilityUnsubscribe) {
      this.capabilityUnsubscribe();
      this.capabilityUnsubscribe = null;
    }
  }

  /** Ensure a peer WSS connection exists or is being established. */
  ensurePeerConnection(peerName: string, input: {
    reason: "startup" | "udp-doorbell" | "outbox";
    jitterMs?: number;
  }): void {
    const existing = this.wsClients.get(peerName);
    if (existing) {
      // Coalesce — client's own state machine handles duplicate triggers
      existing.requestConnect({ reason: input.reason, delayMs: input.jitterMs });
      return;
    }

    const config = loadPeerConfig();
    const entry = config.peers[peerName];
    if (!entry || entry.transport !== "ws-outbound") return;

    const jitter = input.jitterMs ?? Math.floor(Math.random() * CONNECT_JITTER_MAX_MS);
    setTimeout(() => {
      if (this.wsClients.has(peerName)) return;
      const { WsPeerClient: Client } = require("./ws-peer-client.js") as typeof import("./ws-peer-client.js");
      const client = new Client(peerName, entry);
      this.setupWsClient(peerName, client);
      this.wsClients.set(peerName, client);
      client.requestConnect({ reason: input.reason });
      logInfo(TAG, `WS doorbell: connecting to ${peerName} (reason: ${input.reason})`);
    }, jitter).unref();
  }

  async initWsConnections(): Promise<void> {
    const config = loadPeerConfig();
    const { WsPeerClient: Client } = await import("./ws-peer-client.js");
    for (const [name, entry] of Object.entries(config.peers)) {
      if (entry.transport !== "ws-outbound") continue;
      if (this.wsClients.has(name)) continue;
      const client = new Client(name, entry);
      this.setupWsClient(name, client);
      this.wsClients.set(name, client);
      client.requestConnect({ reason: "startup" });
      logInfo(TAG, `WS outbound: connecting to ${name}`);
    }
  }

  private onRouteAvailable(peer: string): void {
    // Send current signed inventory
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
      broker.sendPush(peer, "peer.inventory.v1", payload);
    } catch { /* best effort */ }

    // Drain remote-Pi pending events for this peer
    try {
      const { getRemotePiDelivery } = require("./remote-pi-registry.js") as typeof import("./remote-pi-registry.js");
      const delivery = getRemotePiDelivery();
      if (delivery && typeof delivery.drainPeer === "function") {
        delivery.drainPeer(peer).catch(() => {});
      }
    } catch { /* best effort */ }
  }

  private setupWsClient(_peerName: string, _client: WsPeerClient): void {
    // All pushes are handled by the broker push handler registered in phase-agent-api.
    // The client only owns the dial/reconnect lifecycle.
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
