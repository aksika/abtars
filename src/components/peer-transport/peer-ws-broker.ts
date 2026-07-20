import WebSocket from "ws";
import { logInfo, logWarn, logDebug } from "../logger.js";
import { signRequest, verifyRequest } from "./peer-auth.js";
import { loadPeerConfig } from "../peer-config.js";
import { WsOutboxStore } from "./ws-outbox-store.js";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";

export type PeerSocketDirection = "accepted" | "outbound";

export interface PeerSocketRegistration {
  peer: string;
  direction: PeerSocketDirection;
  generation: number;
  connectedAt: number;
  socket: WebSocket;
}

export type PeerRouteEvent =
  | { type: "available"; peer: string }
  | { type: "unavailable"; peer: string };

type RouteListener = (event: PeerRouteEvent) => void;

const OUTBOX_TIMEOUT_MS = 30_000;
const OUTBOX_MAX = 200;
const OUTBOX_MAX_ENTRY_BYTES = 512 * 1024;
const OUTBOX_MAX_FILE_BYTES = 10 * 1024 * 1024;

type PendingWaiter = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

interface InFlight {
  entryId: string;
  peer: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface PeerRequestHandler {
  (peer: string, method: string, payload: unknown, frameId: string): Promise<unknown>;
}

export interface PeerPushHandler {
  (peer: string, method: string, payload: unknown): Promise<void> | void;
}

interface PeerState {
  outbox: WsOutboxStore;
  sockets: PeerSocketRegistration[];
  waiters: Map<string, PendingWaiter>;
  inFlight: InFlight | null;
  nextGen: number;
  hasRoute: boolean; // tracks whether at least one OPEN socket existed
}

const PUSH_ALLOWLIST = new Set(["pi.lifecycle.v1", "peer.inventory.v1", "notify", "ping"]);

export class PeerWsBroker {
  private peers = new Map<string, PeerState>();
  private requestHandler: PeerRequestHandler | null = null;
  private pushHandler: PeerPushHandler | null = null;
  private routeListeners: RouteListener[] = [];

  registerRequestHandler(handler: PeerRequestHandler): void {
    this.requestHandler = handler;
  }

  registerPushHandler(handler: PeerPushHandler): void {
    this.pushHandler = handler;
  }

  /**
   * Subscribe to route availability transitions.
   * Emits available only for zero-to-one, unavailable only for one-to-zero.
   * Returns an unsubscribe function.
   */
  subscribeRoutes(listener: RouteListener): () => void {
    this.routeListeners.push(listener);
    return () => {
      const idx = this.routeListeners.indexOf(listener);
      if (idx >= 0) this.routeListeners.splice(idx, 1);
    };
  }

  private emitRouteEvent(event: PeerRouteEvent): void {
    const listeners = [...this.routeListeners];
    for (const l of listeners) {
      try { l(event); } catch { /* isolated — subscriber failures do not propagate */ }
    }
  }

  attachSocket(input: { peer: string; direction: PeerSocketDirection; socket: WebSocket }): () => void {
    const { peer, direction, socket } = input;
    let state = this.peers.get(peer);
    if (!state) {
      const filePath = join(abtarsHome(), `ws-outbox-${peer}.json`);
      const outbox = new WsOutboxStore({
        peerName: peer,
        filePath,
        maxEntries: OUTBOX_MAX,
        maxEntryBytes: OUTBOX_MAX_ENTRY_BYTES,
        maxFileBytes: OUTBOX_MAX_FILE_BYTES,
      });
      state = { outbox, sockets: [], waiters: new Map(), inFlight: null, nextGen: 1, hasRoute: false };
      this.peers.set(peer, state);
    }

    const hadRoute = state.hasRoute;

    const generation = state.nextGen++;
    const reg: PeerSocketRegistration = {
      peer,
      direction,
      generation,
      connectedAt: Date.now(),
      socket,
    };
    state.sockets.push(reg);
    this.sortSockets(state);

    // Re-evaluate route presence
    const nowHasRoute = state.sockets.some(s => s.socket.readyState === WebSocket.OPEN);
    state.hasRoute = nowHasRoute;

    socket.on("message", (data) => this.handleMessage(peer, data.toString(), generation));
    socket.on("close", () => {
      this.detachSocket(peer, direction, generation);
    });
    socket.on("error", () => {
      this.detachSocket(peer, direction, generation);
    });

    // #1459: pump pending outbox entries on every attach — resumes pending
    // entries retained across a zero-socket interval.
    this.pump(peer);

    logInfo("peer-broker", `Socket attached: ${peer} ${direction} gen=${generation} (${state.sockets.length} total)`);
    this.publishRouteSnapshot();

    // Emit available only on false-to-true transition
    if (!hadRoute && nowHasRoute) {
      this.emitRouteEvent({ type: "available", peer });
    }

    return () => this.detachSocket(peer, direction, generation);
  }

  /**
   * #1439: Publish the current authenticated-route state (derived from
   * currently OPEN socket registrations across all peers) to the runtime
   * health snapshot so `abtars doctor`'s routes/doorbell probes can read
   * real transport state instead of inferring it from configuration.
   */
  private publishRouteSnapshot(): void {
    import("../runtime-health-snapshot.js").then(({ updateRoutes }) => {
      const routes: Array<{ peer: string; authenticated: true; directions: Array<"accepted" | "outbound">; connectedAt: number }> = [];
      for (const [peer, state] of this.peers) {
        const open = state.sockets.filter(s => s.socket.readyState === WebSocket.OPEN);
        if (open.length === 0) continue;
        const directions = [...new Set(open.map(s => s.direction))];
        const connectedAt = Math.min(...open.map(s => s.connectedAt));
        routes.push({ peer, authenticated: true, directions, connectedAt });
      }
      updateRoutes(routes);
    }).catch(() => { /* best effort — snapshot is a health surface, not authoritative */ });
  }

  hasRoute(peer: string): boolean {
    const state = this.peers.get(peer);
    if (!state) return false;
    return state.sockets.some(s => s.socket.readyState === WebSocket.OPEN);
  }

  async sendRequest<T>(peer: string, method: string, payload: unknown): Promise<T> {
    const state = this.peers.get(peer);
    if (!state) throw new Error(`No peer state for ${peer}`);
    if (state.outbox.isDegraded) throw new Error(`Outbox degraded for ${peer}`);
    if (state.outbox.isFull) throw new Error(`Outbox full for ${peer}`);

    const entry = state.outbox.append(method, payload);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.waiters.delete(entry.id);
        reject(new Error(`Outbox timeout (${peer}/${method})`));
      }, OUTBOX_TIMEOUT_MS);
      state.waiters.set(entry.id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.pump(peer);
    });
  }

  sendPush(peer: string, method: string, payload: unknown): boolean {
    if (!PUSH_ALLOWLIST.has(method)) return false;
    const socket = this.bestSocket(peer);
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: "push", method, payload }));
    return true;
  }

  pushToAll(method: string, payload: unknown): void {
    if (!PUSH_ALLOWLIST.has(method)) return;
    for (const [peer] of this.peers) {
      this.sendPush(peer, method, payload);
    }
  }

  getConnectedPeers(): string[] {
    const result: string[] = [];
    for (const [peer, state] of this.peers) {
      if (state.sockets.some(s => s.socket.readyState === WebSocket.OPEN)) {
        result.push(peer);
      }
    }
    return result;
  }

  /** For testing/inspection: access peer outbox stores. */
  _getOutbox(peer: string): WsOutboxStore | undefined {
    return this.peers.get(peer)?.outbox;
  }

  /** Reset listeners for test isolation. */
  _resetListeners(): void {
    this.routeListeners = [];
    this.requestHandler = null;
    this.pushHandler = null;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private sortSockets(state: PeerState): void {
    state.sockets.sort((a, b) => {
      if (a.connectedAt !== b.connectedAt) return b.connectedAt - a.connectedAt;
      if (a.direction !== b.direction) return a.direction === "outbound" ? -1 : 1;
      return b.generation - a.generation;
    });
  }

  private bestSocket(peer: string): WebSocket | null {
    const state = this.peers.get(peer);
    if (!state) return null;
    for (const reg of state.sockets) {
      if (reg.socket.readyState === WebSocket.OPEN) return reg.socket;
    }
    return null;
  }

  private detachSocket(peer: string, direction: PeerSocketDirection, generation: number): void {
    const state = this.peers.get(peer);
    if (!state) return;
    const idx = state.sockets.findIndex(s => s.direction === direction && s.generation === generation);
    if (idx === -1) return;

    const hadRoute = state.hasRoute;

    state.sockets.splice(idx, 1);
    logDebug("peer-broker", `Socket detached: ${peer} ${direction} gen=${generation} (${state.sockets.length} remaining)`);

    const nowHasRoute = state.sockets.some(s => s.socket.readyState === WebSocket.OPEN);
    state.hasRoute = nowHasRoute;

    this.publishRouteSnapshot();

    // Emit unavailable only on true-to-false transition
    if (hadRoute && !nowHasRoute) {
      this.emitRouteEvent({ type: "unavailable", peer });
    }

    if (state.inFlight && state.inFlight.peer === peer) {
      this.clearInFlight(peer);
      this.pump(peer);
    }

    // #1459: Retain peer state while pending work exists so in-flight waiters
    // and durable outbox entries survive a zero-socket interval. Only delete
    // when truly quiescent (no waiters, no outbox entries, no in-flight).
    if (state.sockets.length === 0 && state.inFlight === null && state.waiters.size === 0 && state.outbox.length === 0) {
      this.peers.delete(peer);
    }
  }

  private handleMessage(peer: string, raw: string, _gen: number): void {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === "response" && msg.id) {
        const state = this.peers.get(peer);
        if (!state) return;

        if (state.inFlight && state.inFlight.entryId === msg.id) {
          state.outbox.acknowledge(msg.id);
          this.clearInFlight(peer);
        }

        const w = state.waiters.get(msg.id);
        if (w) {
          state.waiters.delete(msg.id);
          clearTimeout(w.timer);
          if (msg.error) {
            w.reject(new Error(String(msg.error)));
          } else {
            w.resolve(msg.payload);
          }
        }

        this.pump(peer);
        return;
      }

      if (msg.type === "push") {
        this.pushHandler?.(peer, msg.method, msg.payload);
        return;
      }

      if (msg.type !== "request") return;

      this.handleRequest(peer, msg);
    } catch { /* malformed frame */ }
  }

  private async handleRequest(peer: string, msg: { id?: string; method: string; payload: unknown }): Promise<void> {
    if (!msg.method) return;
    if (!this.requestHandler) {
      logWarn("peer-broker", `No request handler registered for ${peer}:${msg.method}`);
      return;
    }

    const config = loadPeerConfig();
    const peerEntry = config.peers[peer];
    if (!peerEntry?.verifyKey) {
      this.sendError(peer, msg.id, "unknown_peer", "Peer not enrolled");
      return;
    }

    const authFields = ["X-Peer-Id", "X-Peer-Ts", "X-Peer-Nonce", "X-Peer-Sig"];
    const headers: Record<string, string> = {};
    for (const f of authFields) {
      if (typeof (msg as any)[f] === "string") headers[f] = (msg as any)[f];
    }

    const path = `/${msg.method}`;
    const body = typeof msg.payload === "string" ? msg.payload : JSON.stringify(msg.payload ?? {});
    const authResult = verifyRequest(headers, "POST", path, body, peerEntry.verifyKey);
    if (!authResult.ok) {
      this.sendError(peer, msg.id, "auth_failed", `Request auth failed: ${authResult.reason}`);
      return;
    }

    try {
      const result = await this.requestHandler(peer, msg.method, msg.payload, msg.id ?? "");
      this.sendResponse(peer, msg.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDebug("peer-broker", `Handler error for ${peer}:${msg.method}: ${message}`);
      this.sendError(peer, msg.id, "handler_error", message);
    }
  }

  private sendResponse(peer: string, frameId: string | undefined, payload: unknown): void {
    const socket = this.bestSocket(peer);
    if (!socket) return;
    socket.send(JSON.stringify({ type: "response", id: frameId, payload }));
  }

  private sendError(peer: string, frameId: string | undefined, code: string, message: string): void {
    const socket = this.bestSocket(peer);
    if (!socket) return;
    socket.send(JSON.stringify({
      type: "response", id: frameId,
      error: { code, message, retryable: false },
    }));
  }

  private pump(peer: string): void {
    const state = this.peers.get(peer);
    if (!state) return;
    if (state.inFlight) return;
    if (state.outbox.isDegraded) return;

    const socket = this.bestSocket(peer);
    if (!socket) return;

    const entry = state.outbox.peek();
    if (!entry) return;

    state.outbox.recordAttempt(entry.id);

    const config = loadPeerConfig();
    const payloadStr = JSON.stringify(entry.payload);
    const sigHeaders = signRequest("POST", `/${entry.method}`, payloadStr, config.self.signingKey, config.self.name);
    const frame = JSON.stringify({ type: "request", id: entry.id, method: entry.method, payload: entry.payload, ...sigHeaders });

    const timer = setTimeout(() => {
      const currentState = this.peers.get(peer);
      if (!currentState || !currentState.inFlight) return;
      state.outbox.recordAttempt(entry.id, "timeout");
      this.clearInFlight(peer);
      this.pump(peer);
    }, OUTBOX_TIMEOUT_MS);

    state.inFlight = { entryId: entry.id, peer, timer };
    socket.send(frame);
  }

  private clearInFlight(peer: string): void {
    const state = this.peers.get(peer);
    if (!state || !state.inFlight) return;
    clearTimeout(state.inFlight.timer);
    state.inFlight = null;
  }
}

let _broker: PeerWsBroker | null = null;

export function getPeerWsBroker(): PeerWsBroker {
  if (!_broker) _broker = new PeerWsBroker();
  return _broker;
}

export function resetPeerWsBroker(): void {
  if (_broker) _broker._resetListeners();
  _broker = null;
}
