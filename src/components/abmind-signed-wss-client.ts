/**
 * Abtars-owned signed WSS client for remote abmind memory.
 *
 * Implements the signed wire framing, Ed25519 signing, pinned WSS transport,
 * durable logical-request outbox, and typed method wrappers required by
 * abtars. It never imports the abmind package at runtime — protocol constants
 * and canonical builders are represented locally and protected by
 * cross-repository conformance acceptance.
 */

import { createHash, randomBytes, sign } from "node:crypto";
import { createPrivateKey, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import type {
  AbmindClientLike, AbmindCapabilitiesLike,
  AbmindPrivateMemoryLike, AbmindSleepLike,
} from "./abmind-client-contract.js";
import { AbmindRequestOutbox, OUTBOX_MAX_ATTEMPTS } from "./abmind-request-outbox.js";
import type { WssProfile } from "./abmind-endpoint-config.js";

// ── Wire constants (must match abmind's signed-wire protocol) ──────────────

const ABMIND_WSS_DOMAIN_HELLO = "abmind-wss-hello-v1";
const ABMIND_WSS_DOMAIN_REQUEST = "abmind-wss-request-v1";
const ABMIND_PROTOCOL_VERSION = 1;

const WSS_NONCE_BYTES = 16;
const WSS_HANDSHAKE_TIMEOUT_MS = 15_000;
const WSS_REQUEST_TIMEOUT_MS = 120_000;
const WSS_RECONNECT_BASE_MS = 1_000;
const WSS_RECONNECT_MAX_MS = 60_000;
const WSS_RECONNECT_MAX_ATTEMPTS = 10;

interface WssAuthFields {
  peerId: string;
  ts: string;
  nonce: string;
  sig: string;
}

interface SignedAbmindRequestFrameV1 {
  type: "request";
  version: 1;
  id: string;
  method: "abmind.request.v1";
  body: string;
  auth: WssAuthFields;
}

interface AbmindResponseFrameV1 {
  type: "response";
  version: 1;
  id: string;
  body: string;
}

interface AbmindResponseV1 {
  ok: boolean;
  requestId: string;
  result?: unknown;
  error?: { code: string; message: string; current?: unknown };
}

// ── Canonical serialization (conforms to abmind's signed-wire) ─────────────

function buildRequestCanonical(
  version: number,
  peerId: string,
  frameId: string,
  method: string,
  path: string,
  ts: string,
  nonce: string,
  body: string,
): string {
  const bodyHash = createHash("sha256").update(body, "utf-8").digest("hex");
  return `${ABMIND_WSS_DOMAIN_REQUEST}\n${version}\n${peerId}\n${frameId}\n${method}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
}

function buildHelloCanonical(
  version: number,
  peerId: string,
  connectionId: string,
  challenge: string,
  timestamp: string,
): string {
  return `${ABMIND_WSS_DOMAIN_HELLO}\n${version}\n${peerId}\n${connectionId}\n${challenge}\n${timestamp}`;
}

function edSign(privateKeyPem: string, message: string): string {
  const key = createPrivateKey(privateKeyPem);
  return sign(null, Buffer.from(message, "utf-8"), key).toString("base64");
}

// ── Certificate pinning (canonical DER-leaf SHA-256 hex) ───────────────────

const HEX64_RE = /^[0-9a-f]{64}$/;

export function normalizeCertificatePin(input: string): string {
  const normalized = input.trim().toLowerCase();
  if (!HEX64_RE.test(normalized)) {
    throw new Error("Invalid certificate pin: expected 64 lowercase hex characters");
  }
  return normalized;
}

export function verifyCertificatePin(certRaw: Buffer, expectedHex: string): void {
  const expected = normalizeCertificatePin(expectedHex);
  const actual = createHash("sha256").update(certRaw).digest("hex");
  if (actual.length !== expected.length) throw new Error("Certificate pin length mismatch");
  if (!timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))) {
    throw new Error("Certificate pin mismatch");
  }
}

// ── Pending request bookkeeping ────────────────────────────────────────────

type WsState = "closed" | "connecting" | "authenticating" | "negotiating" | "ready" | "reconnecting";

interface PendingRequest {
  resolve: (value: AbmindResponseV1) => void;
  timer: ReturnType<typeof setTimeout>;
  frameJson: string;
  entryId: string;
  requestId: string;
}

interface SendOptions {
  method: string;
  payload: unknown;
  requestId?: string;
  idempotencyKey?: string;
}

export class AbtarsSignedWssClient implements AbmindClientLike {
  private profile: WssProfile;
  private signingKey: string;
  private outbox: AbmindRequestOutbox;
  private socket: WebSocket | null = null;
  private state: WsState = "closed";
  private pending = new Map<string, PendingRequest>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private capabilities_: AbmindCapabilitiesLike | null = null;
  private idemCounter = 0;

  readonly privateMemory: AbmindPrivateMemoryLike;
  readonly sleep: AbmindSleepLike;

  constructor(profile: WssProfile, outboxFilePath: string) {
    this.profile = {
      ...profile,
      serverCertSha256: normalizeCertificatePin(profile.serverCertSha256),
    };
    this.signingKey = readFileSync(profile.signingKeyFile, "utf-8");
    this.outbox = new AbmindRequestOutbox(profile.peerId, outboxFilePath);

    this.privateMemory = {
      instantStore: (p, key) => this.call("private.instantStore", p, key),
      editMemory: (p, key) => this.call("private.edit", p, key),
      recall: (p) => this.call("private.recall", p),
      rebuildFtsIndexes: () => this.call("private.rebuildFts", {}),
      embed: (p) => this.call("private.embed", p),
      recordMessage: (p, key) => this.call("private.recordMessage", p, key),
      getRecentConversation: (p) => this.call("private.getRecentConversation", p),
      assembleSessionContext: (p) => this.call("private.assembleSessionContext", p),
      getRuntimeStatus: (p) => this.call("private.getRuntimeStatus", p ?? {}),
      getCoreKnowledge: (p) => this.call("private.getCoreKnowledge", p),
      recordFeedback: (p, key) => this.call("private.recordFeedback", p, key),
    };

    this.sleep = {
      start: (m, l, f, key) => this.call("sleep.start", { mode: m, level: l, fresh: f }, key) as Promise<{ status: string; runId?: string; reason?: string }>,
      status: () => this.call("sleep.status", {}),
      resume: (runId, level, key) => this.call("sleep.resume", { runId, level }, key) as Promise<{ status: string; runId?: string; reason?: string }>,
      events: (afterSeq, limit, waitMs) => this.call("sleep.events", { afterSeq, limit, waitMs }) as Promise<{ runId: string; events: Array<{ seq: number; at: number; event: { type: string; detail?: string } }>; nextSeq: number; gap: boolean; terminal: boolean }>,
      runtime: {
        open: (id, key) => this.call("sleep.runtime.open", { providerInstanceId: id }, key) as Promise<{ status: string; leaseId?: string; expiresAt?: number }>,
        next: (leaseId, waitMs) => this.call("sleep.runtime.next", { leaseId, waitMs }) as Promise<{ status: string; heartbeat?: true; completionRequest?: { completionId: string; runId: string; stepId: string; prompt: string; deadline: number } }>,
        complete: (leaseId, completionId, text, key) => this.call("sleep.runtime.complete", { leaseId, completionId, text }, key) as Promise<{ status: string }>,
        fail: (leaseId, completionId, code, key) => this.call("sleep.runtime.fail", { leaseId, completionId, code }, key) as Promise<{ status: string }>,
        close: (leaseId, key) => this.call("sleep.runtime.close", { leaseId }, key) as Promise<{ status: string }>,
      },
    };
  }

  get capabilities(): AbmindCapabilitiesLike | null { return this.capabilities_; }

  async negotiate(): Promise<AbmindCapabilitiesLike> {
    if (this.capabilities_) return this.capabilities_;
    const resp = await this.sendInner({ method: "system.negotiate", payload: {} });
    if (resp.ok && resp.result && typeof resp.result === "object") {
      const caps = resp.result as AbmindCapabilitiesLike;
      if (typeof caps.version !== "number" || !Array.isArray(caps.methods) || typeof caps.features !== "object" || caps.features === null) {
        throw new Error("Negotiation failed: malformed capabilities");
      }
      this.capabilities_ = caps;
      return caps;
    }
    throw new Error(`Negotiation failed: ${resp.error?.message ?? "unknown"}`);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.capabilities_ = null;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = null; }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, requestId: p.requestId, error: { code: "unavailable", message: "Transport closed" } });
    }
    this.pending.clear();
    if (this.socket) {
      try { this.socket.close(); } catch { /* best effort */ }
      this.socket = null;
    }
    this.state = "closed";
  }

  /** Raw method call with an explicit caller-supplied idempotency key. */
  async callRaw<T>(method: string, payload: unknown, idempotencyKey?: string): Promise<T> {
    return (await this.call(method, payload, idempotencyKey)) as T;
  }

  private async call(method: string, payload: unknown, idempotencyKey?: string): Promise<unknown> {
    const requestId = `wss-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (this.closed) {
      throw this.errorWithCode("unavailable", "Transport is closed");
    }
    const isMutating = METHOD_IS_MUTATING.has(method);
    let key: string | undefined = idempotencyKey;
    if (isMutating && !key) {
      this.idemCounter++;
      key = `idem-${method}-${Date.now()}-${this.idemCounter}`;
    }

    const body = JSON.stringify({
      version: ABMIND_PROTOCOL_VERSION,
      requestId,
      method,
      idempotencyKey: key,
      payload,
    });

    const response = await this.sendInner({ method, payload, requestId, idempotencyKey: key }, body);
    if (response.ok) {
      return response.result;
    }
    throw this.errorWithCode(response.error?.code ?? "unavailable", response.error?.message ?? "Request failed", response.error?.current);
  }

  private errorWithCode(code: string, message: string, current?: unknown): Error & { code: string; current?: unknown } {
    const err = new Error(message) as Error & { code: string; current?: unknown };
    err.code = code;
    err.current = current;
    return err;
  }

  private async sendInner(req: SendOptions, prebuiltBody?: string): Promise<AbmindResponseV1> {
    if (this.state !== "ready") {
      try {
        await this.connect();
      } catch (err) {
        return { ok: false, requestId: req.requestId ?? "", error: { code: "unavailable", message: `Connection failed: ${(err as Error).message}` } };
      }
    }
    const requestId = req.requestId ?? `wss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = prebuiltBody ?? JSON.stringify({
      version: ABMIND_PROTOCOL_VERSION,
      requestId,
      method: req.method,
      idempotencyKey: req.idempotencyKey,
      payload: req.payload,
    });
    const frameId = `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const appended = this.outbox.append(frameId, req.method, requestId, req.idempotencyKey, body, ABMIND_PROTOCOL_VERSION, req.payload);
    if (!appended) {
      return { ok: false, requestId, error: { code: "unavailable", message: "Outbox persistence failed" } };
    }

    const auth = this.signRequest(frameId, body);
    const frame: SignedAbmindRequestFrameV1 = {
      type: "request", version: 1, id: frameId, method: "abmind.request.v1", body, auth,
    };
    const frameJson = JSON.stringify(frame);

    return new Promise<AbmindResponseV1>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(frameId);
        const attempts = this.outbox.recordAttempt(frameId, "timeout");
        if (attempts !== null && attempts < OUTBOX_MAX_ATTEMPTS) {
          this.scheduleNextPump();
        }
        resolve({ ok: false, requestId, error: { code: "outcome_unknown", message: "Request timeout" } });
      }, WSS_REQUEST_TIMEOUT_MS);

      const pr: PendingRequest = { resolve, timer, frameJson, entryId: frameId, requestId };
      this.pending.set(frameId, pr);

      try {
        this.socket?.send(frameJson);
      } catch {
        this.pending.delete(frameId);
        clearTimeout(timer);
        const attempts = this.outbox.recordAttempt(frameId, "send_failed");
        if (attempts !== null && attempts < OUTBOX_MAX_ATTEMPTS) {
          this.scheduleNextPump();
        }
        resolve({ ok: false, requestId, error: { code: "unavailable", message: "Send failed" } });
      }
    });
  }

  private signRequest(frameId: string, body: string): WssAuthFields {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(WSS_NONCE_BYTES).toString("hex");
    const canonical = buildRequestCanonical(1, this.profile.peerId, frameId, "abmind.request.v1", "/abmind.request.v1", ts, nonce, body);
    const sig = edSign(this.signingKey, canonical);
    return { peerId: this.profile.peerId, ts, nonce, sig };
  }

  private async connect(): Promise<void> {
    if (this.state === "connecting" || this.state === "authenticating") return;

    this.state = "connecting";
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.profile.url, {
        rejectUnauthorized: false,
        handshakeTimeout: WSS_HANDSHAKE_TIMEOUT_MS,
      });

      let connected = false;

      socket.on("open", () => {
        if (!this.verifyServerPin(socket)) {
          socket.close(4003, "Certificate pin mismatch");
          reject(new Error("Server certificate pin mismatch"));
          return;
        }
        this.socket = socket;
        connected = true;
        this.state = "authenticating";
        this.authenticate(socket).then(resolve).catch(reject);
      });

      socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const data: Buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as never);
        this.handleMessage(data.toString("utf-8"));
      });

      socket.on("close", () => {
        if (this.socket === socket) {
          this.socket = null;
          this.state = "closed";
          if (!this.closed) this.scheduleReconnect();
        } else if (this.state === "connecting") {
          this.state = "closed";
          if (!this.closed) this.scheduleReconnect();
        }
        if (!connected) reject(new Error("Connection closed before open"));
      });

      socket.on("error", (err) => {
        if (!connected) {
          this.state = "closed";
          if (!this.closed) this.scheduleReconnect();
          reject(err);
        }
      });
    });
  }

  private verifyServerPin(socket: WebSocket): boolean {
    try {
      const cert = (socket as unknown as { _socket?: { getPeerCertificate(): { raw?: Buffer } } })._socket?.getPeerCertificate();
      if (!cert || !cert.raw) return false;
      verifyCertificatePin(cert.raw, this.profile.serverCertSha256);
      return true;
    } catch {
      return false;
    }
  }

  private async authenticate(socket: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; reject(new Error("Auth timeout")); }
      }, WSS_HANDSHAKE_TIMEOUT_MS);

      const handler = (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const data: Buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as never);
        let msg: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(data.toString("utf-8"));
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
          msg = parsed as Record<string, unknown>;
        } catch {
          return;
        }

        if (msg.type === "challenge" && msg.version === 1) {
          const connectionId = msg.connectionId as string;
          const challenge = msg.challenge as string;
          const timestamp = String(Math.floor(Date.now() / 1000));
          const canonical = buildHelloCanonical(1, this.profile.peerId, connectionId, challenge, timestamp);
          const signature = edSign(this.signingKey, canonical);

          const hello = JSON.stringify({
            type: "hello", version: 1,
            peerId: this.profile.peerId,
            connectionId, challenge, timestamp, signature,
          });
          socket.send(hello);
        } else if (msg.type === "hello_ack") {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            socket.removeListener("message", handler);
            this.state = "ready";
            this.reconnectAttempts = 0;
            this.pumpOutbox();
            resolve();
          }
        }
      };

      socket.on("message", handler);
    });
  }

  private handleMessage(text: string): void {
    try {
      const msg = JSON.parse(text) as AbmindResponseFrameV1;
      if (msg.type !== "response" || msg.version !== 1) return;

      const pending = this.pending.get(msg.id);
      if (!pending) {
        const replay = this.outbox.get(msg.id);
        if (!replay) return;
        const response = JSON.parse(msg.body) as AbmindResponseV1;
        if (!response.ok && response.requestId === msg.id) {
          this.outbox.acknowledge(msg.id);
        } else if (response.requestId === replay.requestId) {
          this.outbox.acknowledge(msg.id);
        }
        return;
      }

      clearTimeout(pending.timer);
      this.pending.delete(msg.id);

      try {
        const response = JSON.parse(msg.body) as AbmindResponseV1;
        if (!response.ok && response.requestId === msg.id) {
          pending.resolve({ ...response, requestId: pending.requestId });
          this.outbox.acknowledge(pending.entryId);
          return;
        }
        if (response.requestId !== pending.requestId) {
          pending.resolve({ ok: false, requestId: pending.requestId, error: { code: "validation_error", message: "Response requestId mismatch" } });
          return;
        }
        const acked = this.outbox.acknowledge(pending.entryId);
        if (!acked) {
          pending.resolve({ ok: false, requestId: msg.id, error: { code: "unavailable", message: "Outbox ack failed" } });
        } else {
          pending.resolve(response);
        }
      } catch {
        pending.resolve({ ok: false, requestId: msg.id, error: { code: "validation_error", message: "Invalid response body" } });
      }
    } catch { /* ignore malformed frames */ }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectAttempts >= WSS_RECONNECT_MAX_ATTEMPTS) return;
    this.reconnectAttempts++;
    const delay = Math.min(
      WSS_RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      WSS_RECONNECT_MAX_MS,
    );
    this.state = "reconnecting";
    this.reconnectTimer = setTimeout(() => {
      if (this.closed) return;
      this.connect().catch(() => {});
    }, delay);
  }

  private pumpOutbox(): void {
    const entry = this.outbox.peek();
    if (!entry) return;
    const attempts = this.outbox.recordAttempt(entry.id);
    if (attempts !== null && attempts >= OUTBOX_MAX_ATTEMPTS) {
      this.outbox.acknowledge(entry.id);
      return;
    }

    const auth = this.signRequest(entry.id, entry.body);
    const frame: SignedAbmindRequestFrameV1 = {
      type: "request", version: 1, id: entry.id, method: "abmind.request.v1", body: entry.body, auth,
    };
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch { /* next pump attempt */ }
    if (!this.pending.has(entry.id)) this.scheduleNextPump();
  }

  private scheduleNextPump(): void {
    if (this.closed || this.state !== "ready") return;
    if (this.outbox.length === 0) return;
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      if (this.outbox.length > 0) this.pumpOutbox();
    }, 5000);
  }
}

// Methods that require an idempotency key on the wire (mirrors abmind's registry).
const METHOD_IS_MUTATING = new Set([
  "private.instantStore", "private.edit", "private.reclassify", "private.adjustRelevance",
  "private.merge", "private.cascadeDelete", "private.rebuildFts", "private.recordMessage",
  "private.recordFeedback", "sleep.start", "sleep.resume", "sleep.cancel",
  "sleep.runtime.open", "sleep.runtime.complete", "sleep.runtime.fail", "sleep.runtime.close",
]);
