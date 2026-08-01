/**
 * Abtars-owned signed WSS client for remote abmind memory.
 *
 * Implements the signed wire framing, Ed25519 signing, pinned WSS transport,
 * durable logical-request outbox, and typed method wrappers required by
 * abtars. It never imports the abmind package at runtime — protocol constants
 * and canonical builders are represented locally and protected by
 * cross-repository conformance acceptance.
 *
 * Route behavior (#1382): only a fully authenticated and renegotiated socket
 * generation admits domain calls. New calls in any non-ready state fail
 * closed with `unavailable` and create no durable work. Admitted calls retry
 * within one persisted wall-clock deadline, preserving frame ID, inner
 * request ID, idempotency key, method, and exact body while refreshing
 * ts/nonce/signature per attempt. Exhausted ambiguous work becomes
 * `terminal_unknown` and is never auto-replayed.
 */

import { createHash, randomBytes, sign } from "node:crypto";
import { createPrivateKey, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import type {
  AbmindClientLike, AbmindCapabilitiesLike,
  AbmindPrivateMemoryLike, AbmindSleepLike,
  AbmindRouteSnapshotV1Like, AbmindRouteStateLike,
} from "./abmind-client-contract.js";
import { AbmindRequestOutbox } from "./abmind-request-outbox.js";
import { AbtarsRouteController } from "./abmind-route-controller.js";
import type { RetryFailureClassLike } from "./abmind-route-contract.js";
import type { WssProfile } from "./abmind-endpoint-config.js";

// ── Wire constants (must match abmind's signed-wire protocol) ──────────────

const ABMIND_WSS_DOMAIN_HELLO = "abmind-wss-hello-v1";
const ABMIND_WSS_DOMAIN_REQUEST = "abmind-wss-request-v1";
const ABMIND_PROTOCOL_VERSION = 1;

const WSS_REQUEST_TIMEOUT_MS = 120_000;

interface WssAuthFields {
  peerId: string;
  ts: string;
  nonce: string;
  sig: string;
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

interface PendingRequest {
  resolve: ((value: AbmindResponseV1) => void) | null;
  timer: ReturnType<typeof setTimeout>;
  requestId: string;
}

export interface AbtarsWssClientOptions {
  /** Injected clock (epoch ms) for deterministic tests. */
  now?: () => number;
  /** Injected random (0..1) for backoff jitter in deterministic tests. */
  random?: () => number;
  requestTimeoutMs?: number;
  retryDeadlineMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  retryJitterMs?: number;
  retryMaxAttempts?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  reconnectMaxAttempts?: number;
}

function retryDelay(opts: AbtarsWssClientOptions, attempts: number, rng: () => number): number {
  const base = opts.retryBaseMs ?? 1_000;
  const max = opts.retryMaxMs ?? 60_000;
  const jitter = opts.retryJitterMs ?? 250;
  const raw = Math.min(base * Math.pow(2, attempts - 1), max);
  const jittered = raw + Math.floor(rng() * (jitter + 1));
  return Math.min(jittered, max + 1000);
}

const MAX_ROUTE_LISTENERS = 8;

export class AbtarsSignedWssClient implements AbmindClientLike {
  private profile: WssProfile;
  private signingKey: string;
  private outbox: AbmindRequestOutbox;
  private controller: AbtarsRouteController;
  private pending = new Map<string, PendingRequest>();
  /** Frame ID → socket generation the frame was last sent on. */
  private sentOnGen = new Map<string, number>();
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private closed_ = false;
  private degraded_ = false;
  private opts: AbtarsWssClientOptions;
  private rng: () => number;
  private routeListeners = new Set<(snapshot: AbmindRouteSnapshotV1Like) => void>();

  readonly privateMemory: AbmindPrivateMemoryLike;
  readonly sleep: AbmindSleepLike;

  constructor(profile: WssProfile, outboxFilePath: string, options: AbtarsWssClientOptions = {}) {
    this.profile = {
      ...profile,
      serverCertSha256: normalizeCertificatePin(profile.serverCertSha256),
    };
    this.signingKey = readFileSync(profile.signingKeyFile, "utf-8");
    this.outbox = new AbmindRequestOutbox(profile.peerId, outboxFilePath, { retryDeadlineMs: options.retryDeadlineMs });
    this.opts = { ...options };
    this.rng = options.random ?? Math.random;
    this.controller = new AbtarsRouteController(
      profile.url,
      profile.peerId,
      {
        signFrame: (frameId, body) => this.signFrame(frameId, body),
        signHello: (connectionId, challenge, timestamp) => ({
          sig: edSign(this.signingKey, buildHelloCanonical(1, this.profile.peerId, connectionId, challenge, timestamp)),
        }),
        verifyServerPin: (socket) => this.verifyServerPin(socket),
      },
      {
        onReady: () => {
          this.schedulePump();
          this.publishRouteChange();
        },
        onRouteLost: () => {
          this.handleRouteLost();
          this.publishRouteChange();
        },
        onMessage: (text, gen) => this.handleMessage(text, gen),
      },
      {
        now: options.now,
        random: options.random,
        reconnectBaseMs: options.reconnectBaseMs,
        reconnectMaxMs: options.reconnectMaxMs,
        reconnectMaxAttempts: options.reconnectMaxAttempts,
      },
    );
    if (this.outbox.isQuarantined) this.degraded_ = true;

    this.privateMemory = {
      instantStore: (p, key) => this.call("private.instantStore", p, key),
      editMemory: (p, key) => this.callPrivateMutation("private.edit", p, key),
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

  get capabilities(): AbmindCapabilitiesLike | null {
    return this.controller.capabilities;
  }

  /** Immutable bounded route snapshot for diagnostics. */
  get routeSnapshot(): AbmindRouteSnapshotV1Like {
    return this.controller.snapshot(this.outbox.counts());
  }

  get routeState(): AbmindRouteStateLike { return this.controller.state; }

  /** Bounded push notifications for diagnostics; returns an unsubscribe fn. */
  onRouteChange(listener: (snapshot: AbmindRouteSnapshotV1Like) => void): () => void {
    if (this.routeListeners.size >= MAX_ROUTE_LISTENERS) {
      throw new Error("Too many route listeners");
    }
    this.routeListeners.add(listener);
    listener(this.routeSnapshot);
    return () => { this.routeListeners.delete(listener); };
  }

  private publishRouteChange(): void {
    const snapshot = this.routeSnapshot;
    for (const listener of this.routeListeners) {
      try { listener(snapshot); } catch { /* diagnostics only */ }
    }
  }

  async negotiate(): Promise<AbmindCapabilitiesLike> {
    if (this.degraded_ || this.outbox.isQuarantined) {
      throw new Error("Outbox state is not usable");
    }
    return this.controller.negotiate();
  }

  async close(): Promise<void> {
    this.closed_ = true;
    if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = null; }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      if (p.resolve) {
        p.resolve({ ok: false, requestId: p.requestId, error: { code: "unavailable", message: "Transport closed" } });
      }
    }
    this.pending.clear();
    this.sentOnGen.clear();
    this.controller.close();
    this.routeListeners.clear();
  }

  /** Raw method call with an explicit caller-supplied idempotency key. */
  async callRaw<T>(method: string, payload: unknown, idempotencyKey?: string): Promise<T> {
    return (await this.call(method, payload, idempotencyKey)) as T;
  }

  /**
   * Semantic mutations expose their bounded failure contract as data, matching
   * the abmind client contract consumed by the memory runtime: a rejected
   * mutation returns { ok: false, code, ... } instead of throwing. Transport
   * and protocol failures outside that contract still reject normally.
   */
  private async callPrivateMutation(
    method: "private.edit",
    payload: unknown,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const result = await this.call(method, payload, idempotencyKey);
      return (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
    } catch (err) {
      const e = err as Error & { code?: string; current?: unknown };
      if (e.code === "conflict" || e.code === "not_found" || e.code === "unauthorized" || e.code === "validation_error") {
        return { ok: false, code: e.code, current: e.current, message: e.message };
      }
      throw err;
    }
  }

  private async call(method: string, payload: unknown, idempotencyKey?: string): Promise<unknown> {
    const requestId = `wss-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (this.closed_) {
      throw this.errorWithCode("unavailable", "Transport is closed");
    }
    if (this.degraded_ || this.outbox.isQuarantined || this.outbox.isDegraded) {
      throw this.errorWithCode("unavailable", "Outbox state is not usable");
    }
    // Fail-closed admission: only a ready current generation admits work.
    if (!this.controller.isReady()) {
      throw this.errorWithCode("unavailable", "Route not ready");
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
    const frameId = `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const appended = this.outbox.append(frameId, method, requestId, key, body, ABMIND_PROTOCOL_VERSION, payload);
    if (!appended) {
      throw this.errorWithCode("unavailable", "Outbox persistence failed");
    }

    const response = await new Promise<AbmindResponseV1>((resolve) => {
      this.pending.set(frameId, { resolve, timer: 0 as unknown as ReturnType<typeof setTimeout>, requestId });
      this.sendEntry(frameId);
    });
    if (response.ok) {
      return response.result;
    }
    throw this.errorWithCode(response.error?.code ?? "unavailable", response.error?.message ?? "Request failed", response.error?.current);
  }

  private idemCounter = 0;

  private errorWithCode(code: string, message: string, current?: unknown): Error & { code: string; current?: unknown } {
    const err = new Error(message) as Error & { code: string; current?: unknown };
    err.code = code;
    err.current = current;
    return err;
  }

  // ── Delivery ─────────────────────────────────────────────────────────────

  private sendEntry(frameId: string): void {
    const entry = this.outbox.get(frameId);
    if (!entry) return;
    if (!this.controller.isReady()) return; // onReady pumps when the route returns
    if (this.sentOnGen.size > 0) return; // one in-flight send; completion paths pump

    const now = this.now();
    if (this.outbox.isExhausted(entry, now)) {
      this.settleTerminalUnknown(frameId, "timeout");
      return;
    }
    if (!this.outbox.markInFlight(frameId)) {
      if (this.outbox.isDegraded) { this.markDegraded(); return; }
      return;
    }

    const auth = this.signFrame(frameId, entry.body);
    const frame = {
      type: "request", version: 1, id: frameId, method: "abmind.request.v1", body: entry.body, auth,
    } as const;
    this.sentOnGen.set(frameId, this.controller.generation);

    const pending = this.pending.get(frameId);
    clearTimeout(pending?.timer);
    const timer = setTimeout(() => {
      const current = this.outbox.get(frameId);
      if (current && current.state === "in_flight") {
        this.recordUncertainFailure(frameId, "timeout");
      }
    }, this.opts.requestTimeoutMs ?? WSS_REQUEST_TIMEOUT_MS);
    if (pending) pending.timer = timer;

    if (!this.controller.send(JSON.stringify(frame))) {
      this.recordUncertainFailure(frameId, "send_failed");
    }
  }

  private recordUncertainFailure(frameId: string, failure: RetryFailureClassLike): void {
    const entry = this.outbox.get(frameId);
    if (!entry || entry.state === "terminal_unknown") return;
    this.sentOnGen.delete(frameId);
    const now = this.now();
    if (this.outbox.isExhausted(entry, now)) {
      this.settleTerminalUnknown(frameId, "timeout");
      return;
    }
    const delay = retryDelay(this.opts, entry.attempts + 1, this.rng);
    if (!this.outbox.markRetryWait(frameId, failure, now + delay)) {
      if (this.outbox.isDegraded) { this.markDegraded(); return; }
    }
    this.schedulePump();
  }

  private settleTerminalUnknown(frameId: string, failure: RetryFailureClassLike): void {
    const entry = this.outbox.get(frameId);
    const pending = this.pending.get(frameId);
    const requestId = entry?.requestId ?? pending?.requestId ?? frameId;
    const acked = this.outbox.markTerminalUnknown(frameId, failure);
    if (!acked && this.outbox.isDegraded) { this.markDegraded(); return; }
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(frameId);
      if (pending.resolve) {
        pending.resolve({ ok: false, requestId, error: { code: "outcome_unknown", message: "Request outcome unknown after retry budget" } });
      }
    }
    this.sentOnGen.delete(frameId);
    this.schedulePump();
  }

  private handleRouteLost(): void {
    const now = this.now();
    for (const [frameId] of this.sentOnGen) {
      const entry = this.outbox.get(frameId);
      if (entry && entry.state === "in_flight") {
        if (this.outbox.isExhausted(entry, now)) {
          this.settleTerminalUnknown(frameId, "socket_lost");
          continue;
        }
        const delay = retryDelay(this.opts, entry.attempts + 1, this.rng);
        if (!this.outbox.markRetryWait(frameId, "socket_lost", now + delay)) {
          if (this.outbox.isDegraded) { this.markDegraded(); return; }
        }
      }
    }
    this.sentOnGen.clear();
  }

  private markDegraded(): void {
    this.degraded_ = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      if (p.resolve) {
        p.resolve({ ok: false, requestId: p.requestId, error: { code: "unavailable", message: "Outbox persistence failed" } });
      }
    }
    this.pending.clear();
    this.sentOnGen.clear();
    this.controller.close();
  }

  private schedulePump(): void {
    if (this.closed_ || this.degraded_ || !this.controller.isReady()) return;
    if (this.pumpTimer) return;
    const now = this.now();
    const due = this.outbox.peekDue(now);
    if (!due) {
      const next = this.outbox.counts().nextAttemptAt;
      if (next !== undefined && next > now) {
        this.pumpTimer = setTimeout(() => {
          this.pumpTimer = null;
          this.schedulePump();
        }, Math.min(next - now, this.opts.requestTimeoutMs ?? WSS_REQUEST_TIMEOUT_MS));
      }
      return;
    }
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      if (this.closed_ || this.degraded_ || !this.controller.isReady()) return;
      const nextDue = this.outbox.peekDue(this.now());
      if (nextDue) this.sendEntry(nextDue.id);
    }, 0);
  }

  // ── Response handling ────────────────────────────────────────────────────

  private handleMessage(text: string, gen: number): void {
    let msg: { type: string; version: number; id: string; body: string };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (msg.type !== "response" || msg.version !== 1) return;

    const sentGen = this.sentOnGen.get(msg.id);
    if (sentGen === undefined || sentGen !== gen) return;

    let response: AbmindResponseV1;
    try {
      response = JSON.parse(msg.body) as AbmindResponseV1;
    } catch {
      return; // malformed response cannot settle or acknowledge
    }

    const pending = this.pending.get(msg.id);
    if (pending) {
      const frameLevelError = !response.ok && response.requestId === msg.id;
      if (!frameLevelError && response.requestId !== pending.requestId) {
        // Wrong inner request ID: ambiguous, never settles a caller.
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      this.sentOnGen.delete(msg.id);
      const acked = this.outbox.acknowledge(msg.id);
      if (!acked) {
        this.markDegraded();
        return;
      }
      if (pending.resolve) {
        pending.resolve(frameLevelError
          ? { ...response, requestId: pending.requestId }
          : response);
      }
      this.schedulePump();
      return;
    }

    const replay = this.outbox.get(msg.id);
    if (!replay) return;
    const frameLevelError = !response.ok && response.requestId === msg.id;
    if (!frameLevelError && response.requestId !== replay.requestId) return;
    this.sentOnGen.delete(msg.id);
    if (!this.outbox.acknowledge(msg.id)) {
      this.markDegraded();
      return;
    }
    this.schedulePump();
  }

  // ── Signing and pin verification ─────────────────────────────────────────

  private signFrame(frameId: string, body: string): WssAuthFields {
    const ts = String(Math.floor(this.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const canonical = buildRequestCanonical(1, this.profile.peerId, frameId, "abmind.request.v1", "/abmind.request.v1", ts, nonce, body);
    const sig = edSign(this.signingKey, canonical);
    return { peerId: this.profile.peerId, ts, nonce, sig };
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

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

// Methods that require an idempotency key on the wire (mirrors abmind's registry).
const METHOD_IS_MUTATING = new Set([
  "private.instantStore", "private.edit", "private.reclassify", "private.adjustRelevance",
  "private.merge", "private.cascadeDelete", "private.rebuildFts", "private.recordMessage",
  "private.recordFeedback", "sleep.start", "sleep.resume", "sleep.cancel",
  "sleep.runtime.open", "sleep.runtime.complete", "sleep.runtime.fail", "sleep.runtime.close",
]);
