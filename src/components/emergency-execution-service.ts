/**
 * emergency-execution-service.ts — runtime-only ACP emergency execution (#1468).
 *
 * A sibling of the normal message pipeline, not a transport mode inside it.
 * One boot-owned instance is reached first from both entry points: the early
 * recovery handler (degraded boot without a normal transport) and the first
 * full-pipeline middleware. It claims only its activation/restore/interrupt
 * controls and ordinary text from the exact active owner binding; everything
 * else falls through to the normal command/recovery path.
 *
 * Structural fast-path contract: a claimed turn calls the dedicated
 * AcpTransport.sendPrompt() directly with a service-owned session key. It
 * never imports or calls Spin, buildPrompt(), hooks, memory runtime methods,
 * conversation buffers, session control, compaction, or the normal transport.
 */

import { randomBytes } from "node:crypto";
import { sanitizeOutbound } from "./sanitize-outbound.js";
import { logError, logInfo, logWarn } from "./logger.js";
import type { InboundMessage, PlatformAdapter } from "../types/platform.js";
import type { AcpTransport } from "./transport/acp-transport.js";
import { AcpExitError, ModelNotFoundError } from "./transport/acp-transport.js";
import type { ProviderConfig } from "./transport-config.js";
import {
  loadTransportStructured,
  resolveHailMary as resolveHailMaryConfig,
  validateModelProviderPair,
  validateProviderReady,
} from "./transport-config.js";
import { getEnv } from "./env-schema.js";
import { loadUsers } from "./user-registry.js";
import { AcpTransport as AcpTransportClass } from "./transport/acp-transport.js";

export interface EmergencyOwner {
  userId: string;
  platform: string;
  channelId: string;
  threadId?: string;
}

export type EmergencyState =
  | { kind: "inactive" }
  | { kind: "starting"; owner: EmergencyOwner }
  | { kind: "ready"; owner: EmergencyOwner }
  | { kind: "running"; owner: EmergencyOwner; generation: number }
  | { kind: "stopping"; owner: EmergencyOwner | null };

export type EmergencyHandleResult = "handled" | "pass";

/** Injectable seams — production defaults are wired by the factory; tests
 *  replace the external boundaries (config, readiness, transport, roles). */
export interface EmergencyExecutionDeps {
  /** Bridge working directory for the dedicated ACP client. */
  workingDir: string;
  /** Reload the current validated schema-v3 transport config (null when
   *  missing or invalid — the loader's own semantics, no repair). */
  loadConfig(): import("./transport-config.js").TransportConfig | null;
  /** Resolve hailMary + its provider config from a validated config. */
  resolveHailMary(config: import("./transport-config.js").TransportConfig): import("./transport-config.js").ResolvedHailMary | null;
  /** Existing model/provider compatibility check. */
  validatePair(model: string, provider: string): import("./transport-config.js").ModelProviderValidation;
  /** Existing provider readiness check (CLI runnable, API key present...). */
  validateReady(providerName: string, provider: ProviderConfig): import("./transport-config.js").ProviderValidationResult;
  /** Dedicated ACP client factory (abtars-emergency identity, no auto-reinit). */
  createAcpTransport(opts: { cli: string; model: string }): AcpTransport;
  /** Current registry role lookup — authorization never relies on the normal
   *  command registry. */
  isMasterUser(userId: string): boolean;
  /** Deadline budget for one emergency turn (existing prompt inactivity
   *  timeout; no background timer or heartbeat is added). */
  promptTimeoutMs(): number;
}

const TAG = "emergency";

function sameOwner(a: EmergencyOwner, b: EmergencyOwner): boolean {
  return a.userId === b.userId
    && a.platform === b.platform
    && a.channelId === b.channelId
    && (a.threadId ?? "") === (b.threadId ?? "");
}

function ownerOf(msg: InboundMessage): EmergencyOwner {
  return { userId: msg.userId, platform: msg.platform, channelId: msg.channelId, threadId: msg.threadId };
}

function emergencySessionKey(owner: EmergencyOwner): string {
  return `emergency:${owner.userId}:${owner.platform}:${owner.channelId}:${owner.threadId ?? ""}`;
}

type EmergencyAction =
  | { kind: "pass" }
  | { kind: "activate" }
  | { kind: "restore" }
  | { kind: "interrupt" }
  | { kind: "turn" };

/** Exact, case-insensitive command classification after trimming. */
function classify(text: string, state: EmergencyState, isOwner: boolean, msg: InboundMessage): EmergencyAction {
  const normalized = text.trim().toLowerCase();
  const activation = normalized === "/emergency"
    || normalized === "/model emergency"
    || normalized === "/models emergency"
    || normalized === "/model hailmary"
    || normalized === "/models hailmary";
  if (activation) return { kind: "activate" };

  const hasOwner = state.kind !== "inactive" && state.owner !== null && state.owner !== undefined;
  const restore = normalized === "/model restore" || normalized === "/models restore";
  if (restore) return hasOwner ? { kind: "restore" } : { kind: "pass" };

  const interrupt = normalized === "/stop" || normalized === "/ctrlc";
  if (interrupt) return hasOwner ? { kind: "interrupt" } : { kind: "pass" };

  // Unsupported media from the active owner binding is claimed with a bounded
  // text-only instruction and never falls through into the normal pipeline.
  if (hasOwner && isOwner && (msg.isVoice || Boolean(msg.mediaPath))) return { kind: "turn" };

  if (hasOwner && isOwner && !text.trim().startsWith("/")) return { kind: "turn" };

  return { kind: "pass" };
}

export class EmergencyExecutionService {
  private state: EmergencyState = { kind: "inactive" };
  private transport: AcpTransport | null = null;
  /** Monotonically increasing execution generation — fences delivery. */
  private generation = 0;
  /** Set once shutdown begins — new activation/turn requests fail closed. */
  private shutdownBegun = false;
  /** Serialized transition seam: every state mutation runs through one
   *  chain; a rejected operation never poisons the next one. The in-flight
   *  prompt itself does NOT hold the chain — interrupt/restore/shutdown must
   *  reach it preemptively — so a turn is a claim segment, the await, and a
   *  completion segment, each mutated only inside the seam. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: EmergencyExecutionDeps) {}

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  status(): Readonly<EmergencyState> {
    return this.state;
  }

  /** Bounded operator-facing description; null when inactive. */
  describeForOperator(): string | null {
    const s = this.state;
    if (s.kind === "inactive") return null;
    const model = this.transport?.getModel?.() ?? "unknown";
    const owner = s.owner ? ` (owner ${s.owner.userId})` : "";
    return `Emergency: ${s.kind}${owner}${s.kind === "ready" || s.kind === "running" ? `, model ${model}` : ""}`;
  }

  /**
   * Offer an inbound message to the emergency path. Returns "handled" when the
   * service claimed it (activation/restore/interrupt control or an ordinary
   * turn of the active binding), "pass" otherwise. Never throws — every
   * outcome is delivered as a bounded reply or falls through.
   */
  async handleInbound(msg: InboundMessage, adapter: PlatformAdapter): Promise<EmergencyHandleResult> {
    const snapshot = this.state;
    const owner = snapshot.kind === "inactive" ? null : snapshot.owner;
    const isOwner = owner !== null && sameOwner(owner, ownerOf(msg));
    const action = classify(msg.text, snapshot, isOwner, msg);

    try {
      switch (action.kind) {
        case "pass":
          return "pass";
        case "activate":
          return this.runSerialized(() => this.activate(msg, adapter));
        case "restore":
          return this.runSerialized(() => this.restore(msg, adapter, isOwner));
        case "interrupt":
          return this.runSerialized(() => this.interrupt(msg, adapter, isOwner));
        // A turn manages its own serialized claim/completion segments (the
        // in-flight prompt must not hold the seam) — never wrap it here.
        case "turn":
          return this.executeTurn(msg, adapter, owner!, isOwner);
      }
    } catch (err) {
      // A rejected operation must not escape into the inbound path or poison
      // the transition chain; the next operation still executes.
      logError(TAG, `Emergency inbound failed: ${err instanceof Error ? err.message : String(err)}`);
      await this.safeReply(adapter, msg, "Emergency mode hit an internal error. Try again or use /model restore.");
      return "handled";
    }
  }

  // ── Activation ────────────────────────────────────────────────────────────

  private async activate(msg: InboundMessage, adapter: PlatformAdapter): Promise<EmergencyHandleResult> {
    if (this.shutdownBegun) {
      await this.safeReply(adapter, msg, "Emergency mode is shutting down — try again after restart.");
      return "handled";
    }
    const snapshot = this.state;
    if (snapshot.kind === "stopping") {
      await this.safeReply(adapter, msg, "Emergency mode is shutting down — try again shortly.");
      return "handled";
    }
    if (snapshot.kind !== "inactive") {
      // Second activation while active reports the existing binding without
      // creating another transport.
      if (snapshot.owner && sameOwner(snapshot.owner, ownerOf(msg))) {
        await this.safeReply(adapter, msg, `Emergency mode is already active for this conversation (${snapshot.kind}). Send a text message to use it, or /model restore to exit.`);
      } else {
        await this.safeReply(adapter, msg, "Emergency mode is already active for another conversation. Only that owner can restore or use it.");
      }
      return "handled";
    }

    if (!this.deps.isMasterUser(msg.userId)) {
      await this.safeReply(adapter, msg, "Emergency mode is owner-only (master role).");
      return "handled";
    }

    const owner = ownerOf(msg);
    this.state = { kind: "starting", owner };
    let transport: AcpTransport | null = null;
    try {
      const validated = this.validateHailMary();
      if (!validated.ok) {
        await this.safeReply(adapter, msg, `Emergency activation failed: ${validated.reason}`);
        this.state = { kind: "inactive" };
        return "handled";
      }
      transport = this.deps.createAcpTransport({ cli: validated.cli, model: validated.hailMary.model });
      await transport.initialize();
      this.transport = transport;
      this.state = { kind: "ready", owner };
      logInfo(TAG, `Emergency mode active for ${owner.userId} (${validated.hailMary.model})`);
      await this.safeReply(adapter, msg, `Emergency mode active (${validated.hailMary.model}). Send a plain text message; use /stop to interrupt and /model restore to exit.`);
    } catch (err) {
      logError(TAG, `Emergency activation failed: ${err instanceof Error ? err.message : String(err)}`);
      if (transport) {
        try { transport.destroy(); } catch { /* best effort */ }
      }
      this.state = { kind: "inactive" };
      await this.safeReply(adapter, msg, `Emergency activation failed: ${this.boundedReason(err)}`);
    }
    return "handled";
  }

  /** Atomic config + readiness validation before any transport is disturbed. */
  private validateHailMary(): { ok: true; hailMary: import("./transport-config.js").ResolvedHailMary; cli: string } | { ok: false; reason: string } {
    const config = this.deps.loadConfig();
    if (!config) return { ok: false, reason: "transport.json is missing or invalid" };
    const hailMary = this.deps.resolveHailMary(config);
    if (!hailMary) return { ok: false, reason: 'hailMary is not configured in transport.json (add hailMary: { route: "acp", model, provider })' };
    if (hailMary.route !== "acp") return { ok: false, reason: `hailMary route must be "acp", got "${hailMary.route}"` };
    const provider = config.providers[hailMary.provider];
    if (!provider) return { ok: false, reason: `hailMary provider "${hailMary.provider}" is not defined in transport.json` };
    const pair = this.deps.validatePair(hailMary.model, hailMary.provider);
    if (!pair.ok) return { ok: false, reason: pair.reason };
    const ready = this.deps.validateReady(hailMary.provider, provider);
    if (!ready.ok) return { ok: false, reason: ready.reason };
    const cli = provider.cli;
    if (!cli) return { ok: false, reason: `ACP provider "${hailMary.provider}" has no 'cli' field in transport.json` };
    return { ok: true, hailMary, cli };
  }

  // ── Turn execution and delivery fencing ───────────────────────────────────

  private async executeTurn(msg: InboundMessage, adapter: PlatformAdapter, owner: EmergencyOwner, isOwner: boolean): Promise<EmergencyHandleResult> {
    // Fast reject outside the seam (read-only) so a busy reply is immediate
    // and never queued behind the in-flight prompt.
    const snapshot = this.state;
    if (snapshot.kind === "running") {
      await this.safeReply(adapter, msg, "One emergency request is already running — wait for it to finish.");
      return "handled";
    }
    if (snapshot.kind === "starting") {
      await this.safeReply(adapter, msg, "Emergency mode is still activating — try again shortly.");
      return "handled";
    }
    if (snapshot.kind === "stopping") {
      await this.safeReply(adapter, msg, "Emergency mode is shutting down.");
      return "handled";
    }
    // Unsupported media from the active owner binding stays on the emergency
    // side — it must never fall through into normal processing.
    if (msg.isVoice || Boolean(msg.mediaPath)) {
      await this.safeReply(adapter, msg, "Emergency mode currently accepts text only.");
      return "handled";
    }
    if (!isOwner) {
      await this.safeReply(adapter, msg, "Emergency mode is active for another conversation.");
      return "handled";
    }

    // Claim segment (serialized): the later transition sees the committed
    // result of earlier ones — a second claim observes `running`.
    const claim = await this.runSerialized(async () => {
      const s = this.state;
      if (s.kind !== "ready" || !this.transport) return null;
      const generation = ++this.generation;
      const transport = this.transport;
      this.state = { kind: "running", owner, generation };
      return { generation, transport };
    });
    if (!claim) return "handled";

    const { generation, transport } = claim;
    const requestId = randomBytes(6).toString("hex");
    try {
      // Trusted request metadata derived from inbound/bridge state, never from
      // prompt content. No Spin, prompt builder, hooks, memory, or compaction.
      // The prompt runs OUTSIDE the seam so /stop, /model restore, and
      // shutdown can preempt it.
      const response = await transport.sendPrompt(emergencySessionKey(owner), msg.text, undefined, {
        userId: owner.userId,
        sessionType: "A",
        executionId: `emergency:${generation}:${requestId}`,
        authorizationMode: "interactive",
        deadlineAt: Date.now() + this.deps.promptTimeoutMs(),
      });

      // Completion segment (serialized): fence before any delivery.
      await this.runSerialized(async () => {
        if (!this.isCurrent(owner, generation, transport)) return;
        await this.deliver(msg, adapter, response, owner, generation, transport);
      });
    } catch (err) {
      await this.runSerialized(async () => {
        if (!this.isCurrent(owner, generation, transport)) return;
        logWarn(TAG, `Emergency turn failed: ${err instanceof Error ? err.message : String(err)}`);
        await this.safeReply(adapter, msg, `Emergency request failed: ${this.boundedReason(err)}`);
        // Recover to ready only when the same client remains operational;
        // otherwise destroy it and become inactive. No background replacement.
        if (transport.isReady) {
          this.state = { kind: "ready", owner };
        } else {
          this.destroyCandidate();
          this.state = { kind: "inactive" };
        }
      });
    }
    return "handled";
  }

  /** Generation-fenced delivery: sanitize, chunk via the platform boundary,
   *  deliver exactly once, never replay a partial failure. */
  private async deliver(
    msg: InboundMessage,
    adapter: PlatformAdapter,
    response: string,
    owner: EmergencyOwner,
    generation: number,
    transport: AcpTransport,
  ): Promise<void> {
    const clean = sanitizeOutbound(response);
    if (!clean) {
      this.state = { kind: "ready", owner };
      await this.safeReply(adapter, msg, "(no response)");
      return;
    }
    const chunks = adapter.chunkResponse(clean);
    try {
      for (const chunk of chunks) {
        if (!this.isCurrent(owner, generation, transport)) return;
        await adapter.sendMessage(msg.channelId, chunk, { threadId: msg.threadId });
      }
    } catch (err) {
      // Delivery failure propagates to the service's error boundary and is
      // logged; it never causes the prompt to be replayed automatically.
      logError(TAG, `Emergency delivery failed (content-free): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (this.isCurrent(owner, generation, transport)) {
        this.state = { kind: "ready", owner };
      }
    }
  }

  /** A stale completion (interrupt/restore/shutdown/later turn) is dropped. */
  private isCurrent(owner: EmergencyOwner, generation: number, transport: AcpTransport): boolean {
    const s = this.state;
    return s.kind === "running"
      && s.generation === generation
      && sameOwner(s.owner, owner)
      && this.transport === transport;
  }

  // ── Interrupt / restore / shutdown ───────────────────────────────────────

  private async interrupt(msg: InboundMessage, adapter: PlatformAdapter, isOwner: boolean): Promise<EmergencyHandleResult> {
    const snapshot = this.state;
    if (snapshot.kind === "inactive") return "pass";
    if (!isOwner) {
      await this.safeReply(adapter, msg, "Emergency mode is active for another conversation — interrupt is owner-only.");
      return "handled";
    }
    if (snapshot.kind === "starting") {
      await this.safeReply(adapter, msg, "Emergency mode is still activating — wait a moment.");
      return "handled";
    }
    if (snapshot.kind === "stopping") {
      await this.safeReply(adapter, msg, "Emergency mode is shutting down.");
      return "handled";
    }
    // Invalidate delivery FIRST so a late result cannot deliver even if
    // cancellation races. Repeated interrupt is idempotent.
    this.generation++;
    const transport = this.transport;
    if (transport) {
      try { await transport.sendInterrupt(); } catch { /* idempotent */ }
    }
    this.state = { kind: "ready", owner: snapshot.owner! };
    await this.safeReply(adapter, msg, "Emergency response interrupted. Ready for the next message.");
    return "handled";
  }

  private async restore(msg: InboundMessage, adapter: PlatformAdapter, isOwner: boolean): Promise<EmergencyHandleResult> {
    const snapshot = this.state;
    if (snapshot.kind === "inactive") return "pass"; // falls through to the unchanged config-rollback command
    if (snapshot.kind === "stopping") {
      await this.safeReply(adapter, msg, "Emergency mode is shutting down.");
      return "handled";
    }
    if (!isOwner) {
      await this.safeReply(adapter, msg, "Emergency mode is active for another conversation — restore is owner-only.");
      return "handled";
    }
    // Restore wins over any late prompt outcome: fence delivery, interrupt an
    // active turn, destroy the client, clear owner and session state. The
    // transport.json.old rollback pair is never read or written here.
    this.generation++;
    const transport = this.transport;
    if (snapshot.kind === "running" && transport) {
      try { await transport.sendInterrupt(); } catch { /* idempotent */ }
    }
    this.destroyCandidate();
    this.state = { kind: "inactive" };
    logInfo(TAG, `Emergency mode restored for ${snapshot.owner?.userId ?? "unknown"}`);
    await this.safeReply(adapter, msg, "Emergency mode restored. Normal routing is unchanged.");
    return "handled";
  }

  /** Fenced interrupt/destroy cleanup — same ordering as restore; idempotent.
   *  After shutdown begins, new activation/turn requests fail closed. */
  async shutdown(): Promise<void> {
    this.shutdownBegun = true;
    await this.runSerialized(async () => {
      const snapshot = this.state;
      if (snapshot.kind === "inactive") return;
      this.state = { kind: "stopping", owner: snapshot.owner ?? null };
      this.generation++;
      const transport = this.transport;
      if (snapshot.kind === "running" && transport) {
        try { await transport.sendInterrupt(); } catch { /* idempotent */ }
      }
      this.destroyCandidate();
      this.state = { kind: "inactive" };
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private destroyCandidate(): void {
    const transport = this.transport;
    this.transport = null;
    if (transport) {
      try { transport.destroy(); } catch { /* best effort */ }
    }
  }

  private async safeReply(adapter: PlatformAdapter, msg: InboundMessage, text: string): Promise<void> {
    const clean = sanitizeOutbound(text);
    if (!clean) return;
    try {
      await adapter.sendMessage(msg.channelId, clean, { threadId: msg.threadId });
    } catch (err) {
      logWarn(TAG, `Emergency reply delivery failed (content-free): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Bounded user-facing reason — never prompt content, raw provider payloads,
   *  credentials, filesystem paths, or stack traces. */
  private boundedReason(err: unknown): string {
    if (err instanceof AcpExitError) return `the agent process exited (code ${err.code ?? "unknown"})`;
    if (err instanceof ModelNotFoundError) return err.message;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Bridge prompt timeout")) return "timed out waiting for a response";
    return "unexpected error (see bridge logs)";
  }
}

/** Production construction — stable boot/config dependencies only. */
export function createEmergencyExecutionService(workingDir: string): EmergencyExecutionService {
  return new EmergencyExecutionService({
    workingDir,
    loadConfig: () => {
      const result = loadTransportStructured();
      return result.ok ? result.config : null;
    },
    resolveHailMary: (config) => resolveHailMaryConfig(config),
    validatePair: (model, provider) => validateModelProviderPair(model, provider),
    validateReady: (providerName, provider) => validateProviderReady(providerName, provider, getEnv()),
    createAcpTransport: (opts) => new AcpTransportClass(opts.cli, workingDir, {
      agent: "abtars-emergency",
      model: opts.model,
      autoReinit: false,
      tag: "acp-emergency",
    }),
    isMasterUser: (userId) => loadUsers().byUserId.get(userId)?.role === "master",
    promptTimeoutMs: () => getEnv().promptTimeoutSec * 1000,
  });
}
