import WebSocket from "ws";
import { logInfo, logWarn, logDebug } from "../logger.js";
import { signWsRequest, verifyWsRequestSignature } from "./peer-auth.js";
import { PeerNonceStore } from "./peer-nonce-store.js";
import { loadPeerConfig } from "../peer-config.js";
import { WsOutboxStore } from "./ws-outbox-store.js";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";

// ── Exported bounds (#1390) ─────────────────────────────────────────────────
export const MAX_FRAME_BYTES = 1_048_576;  // 1 MiB raw WSS frame
export const MAX_ID_BYTES = 64;            // UUID or compact ID
export const MAX_METHOD_BYTES = 48;        // "help.request.v1" length
export const MAX_PEER_ID_BYTES = 128;      // peer name length
export const MAX_NONCE_BYTES = 64;         // hex-encoded 32-byte nonce
export const MAX_SIG_BYTES = 128;          // base64 Ed25519 sig
export const MAX_BODY_BYTES = 524_288;     // 512 KiB body
export const MAX_TIMESTAMP_STR_BYTES = 16; // "9999999999"
export const HELP_METHODS = new Set(["help.request.v1", "help.status.v1", "help.withdraw.v1", "help.event.v1"]);

const WIRE_TOKEN_RE = /^[A-Za-z0-9._:-]+$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const SIG_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isBoundedToken(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && utf8Bytes(value) <= maxBytes && WIRE_TOKEN_RE.test(value);
}

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
  private nonceStore: PeerNonceStore | null = null;

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

  private handleMessage(peer: string, raw: string, gen: number): void {
    // Reject oversized raw frame before parsing
    if (utf8Bytes(raw) > MAX_FRAME_BYTES) return;
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

      this.handleRequest(peer, msg, gen);
    } catch { /* malformed frame */ }
  }

  /** #1390: v1 request handler with full authentication pipeline. */
  private async handleRequest(peer: string, msg: any, gen: number): Promise<void> {
    // 1. Validate type/version/bounded fields/closed method membership
    if (msg.version !== 1) {
      this.rejectRequest(peer, msg, gen, "invalid_frame", "Invalid request version");
      return;
    }
    if (!isBoundedToken(msg.id, MAX_ID_BYTES)) {
      this.rejectRequest(peer, msg, gen, "invalid_frame", "Invalid request ID");
      return;
    }
    if (typeof msg.method !== "string" || utf8Bytes(msg.method) > MAX_METHOD_BYTES) {
      this.rejectRequest(peer, msg, gen, "invalid_frame", "Invalid request method");
      return;
    }
    if (!HELP_METHODS.has(msg.method)) {
      this.rejectRequest(peer, msg, gen, "unsupported_method", "Unsupported request method");
      return;
    }
    if (typeof msg.body !== "string" || utf8Bytes(msg.body) > MAX_BODY_BYTES) {
      this.rejectRequest(peer, msg, gen, "invalid_frame", "Invalid request body");
      return;
    }
    const body = msg.body;
    const auth = msg.auth;
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
      this.rejectRequest(peer, msg, gen, "invalid_frame", "Invalid request authentication");
      return;
    }
    if (!isBoundedToken(auth.peerId, MAX_PEER_ID_BYTES)) {
      this.rejectRequest(peer, msg, gen, "invalid_frame", "Invalid request peer");
      return;
    }
    if (typeof auth.ts !== "string" || !/^\d{1,16}$/.test(auth.ts) || utf8Bytes(auth.ts) > MAX_TIMESTAMP_STR_BYTES) {
      this.rejectRequest(peer, msg, gen, "invalid_frame", "Invalid request timestamp");
      return;
    }
    if (typeof auth.nonce !== "string" || utf8Bytes(auth.nonce) > MAX_NONCE_BYTES || !NONCE_RE.test(auth.nonce)) {
      this.rejectRequest(peer, msg, gen, "invalid_frame", "Invalid request nonce");
      return;
    }
    if (typeof auth.sig !== "string" || utf8Bytes(auth.sig) > MAX_SIG_BYTES || auth.sig.length % 4 !== 0 || !SIG_RE.test(auth.sig)) {
      this.rejectRequest(peer, msg, gen, "invalid_frame", "Invalid request signature");
      return;
    }

    // 2. Signed peerId must match socket identity
    if (auth.peerId !== peer) {
      this.sendError(peer, msg.id, "auth_failed", "Peer identity mismatch", gen);
      return;
    }

    // 3. Look up enrolled key (must exist for this peer)
    const config = loadPeerConfig();
    const peerEntry = config.peers[peer];
    if (!peerEntry?.verifyKey) {
      this.sendError(peer, msg.id, "auth_failed", "Peer not enrolled", gen);
      return;
    }

    // 4. Verify Ed25519 signature (WSS domain, no nonce check yet)
    const path = `/${msg.method}`;
    const sigResult = verifyWsRequestSignature(
      { peerId: auth.peerId, requestId: msg.id, ts: auth.ts, nonce: auth.nonce, sig: auth.sig },
      msg.method,
      path,
      body,
      peerEntry.verifyKey,
    );
    if (!sigResult.ok) {
      this.sendError(peer, msg.id, "auth_failed", `Request auth failed: ${sigResult.reason}`, gen);
      return;
    }

    // 5. Atomic nonce claim (after crypto, before dispatch)
    if (!this.nonceStore) {
      try {
        this.nonceStore = new PeerNonceStore();
      } catch {
        this.sendError(peer, msg.id, "auth_failed", "Store error", gen);
        return;
      }
    }
    const claimResult = this.nonceStore.claim(auth.peerId, auth.nonce);
    if (!claimResult.ok) {
      this.sendError(peer, msg.id, "auth_failed", claimResult.reason === "replay" ? "Nonce replay" : "Store error", gen);
      return;
    }

    // 6. Parse body once, after authentication
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      this.sendError(peer, msg.id, "invalid_frame", "Malformed body", gen);
      return;
    }

    // 7. Check handler exists (after auth, before dispatch — never leaks
    //    handler state before authentication succeeds)
    if (!this.requestHandler) {
      logWarn("peer-broker", `No request handler registered for ${peer}:${msg.method}`);
      return;
    }

    // 8. Dispatch to handler
    try {
      const result = await this.requestHandler(peer, msg.method, payload, msg.id);
      this.sendResponse(peer, msg.id, result, gen);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDebug("peer-broker", `Handler error for ${peer}:${msg.method}: ${message}`);
      this.sendError(peer, msg.id, "handler_error", message, gen);
    }
  }

  private sendResponse(peer: string, frameId: string | undefined, payload: unknown, gen?: number): void {
    const socket = gen !== undefined ? this.socketByGeneration(peer, gen) : this.bestSocket(peer);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "response", id: frameId, payload }));
  }

  private sendError(peer: string, frameId: string | undefined, code: string, message: string, gen?: number): void {
    const socket = gen !== undefined ? this.socketByGeneration(peer, gen) : this.bestSocket(peer);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: "response", id: frameId,
      error: { code, message, retryable: false },
    }));
  }

  private rejectRequest(peer: string, msg: any, gen: number, code: string, message: string): void {
    // Only echo a syntactically bounded ID; malformed frames otherwise have no
    // safe correlation value for a response.
    if (isBoundedToken(msg?.id, MAX_ID_BYTES)) this.sendError(peer, msg.id, code, message, gen);
  }

  private socketByGeneration(peer: string, generation: number): WebSocket | null {
    const state = this.peers.get(peer);
    if (!state) return null;
    const reg = state.sockets.find(s => s.generation === generation);
    return reg?.socket ?? null;
  }

  /** #1390: pump sends a v1 envelope signed with the WSS domain. */
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
    const body = JSON.stringify(entry.payload);
    const auth = signWsRequest(
      config.self.name,
      entry.id,
      entry.method,
      `/${entry.method}`,
      body,
      config.self.signingKey,
    );
    const frame = JSON.stringify({
      type: "request",
      version: 1,
      id: entry.id,
      method: entry.method,
      body,
      auth: { peerId: config.self.name, ...auth },
    });

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
