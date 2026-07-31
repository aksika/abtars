/**
 * skill-session.ts — K interactive skill session manager (#1432).
 *
 * K is a persistent, non-active Spin session scoped to exactly one skill and
 * one conversation address (userId, platform, chatId, threadId). This manager
 * owns skill validation, durable binding metadata, and K transport lifecycle.
 * Spin owns sessions/transports; the pipeline owns inbound/response delivery;
 * the scheduled runner owns the initial scheduled settlement.
 *
 * The old implementation dispatched T, invented `skill_*` IDs, recorded only
 * chatId, never routed the pipeline to Spin's real session, and lost all
 * state on restart. None of that survives here.
 */

import { logInfo, logWarn } from "./logger.js";
import type { AgentName } from "./subagent-runtime.js";
import type { ManagedSession, SessionType } from "./spin-types.js";
import {
  SkillSessionStore,
  scopeKeyOf,
  type ConversationAddress,
  type SkillBindingRecordV1,
} from "./skill-session-store.js";
import {
  buildBootstrap,
  loadSkill,
  listRunnableSkillsStrict,
  type SkillLoadErrorCode,
} from "./skill-loader.js";

const TAG = "skill-session";
const FALLBACK_TIMEOUT_MS = 30 * 60 * 1000;
const EXPIRY_CHECK_INTERVAL_MS = 60 * 1000;

export interface SkillLaunchInput {
  skill: string;
  agent: AgentName;
  target: ConversationAddress;
  message: string;
}

export type SkillLaunchErrorCode = SkillLoadErrorCode | "transport_failed" | "capacity_exhausted";

export interface SkillLaunchError {
  code: SkillLaunchErrorCode;
  message: string;
}

export type SkillLaunchResult =
  | { ok: true; kind: "launched" | "resumed"; sessionId: string; response: string; skillName: string }
  | { ok: false; error: SkillLaunchError };

/** In-memory extension of the durable record: process-local session + bootstrap flag. */
interface ActiveBinding extends SkillBindingRecordV1 {
  sessionId?: string;
  needsBootstrap: boolean;
}

export type SkillRouteResult =
  | { kind: "active"; sessionId: string; needsBootstrap: boolean }
  | { kind: "none" }
  | { kind: "fallback_to_main" };

export interface SkillBindingView {
  skillName: string;
  agent: AgentName;
  sessionId?: string;
  startedAt: number;
  lastActiveAt: number;
  expiresAt: number;
}

/** Narrow Spin facade the manager needs (dynamic import to avoid cycles). */
export interface SkillSpinFacade {
  getSessionById(id: string): ManagedSession | undefined;
  createSubSession(userId: string, platform: string, type: SessionType): ManagedSession | string;
  ensureSessionTransport(session: ManagedSession): Promise<void>;
  spin(spec: {
    type: SessionType;
    sessionId: string;
    prompt: string;
    userId?: string;
    settlementOwner: "spin";
    await: true;
  }): Promise<{ sessionId: string; result?: string }>;
  finalizeExactSession(sessionId: string, expectedUserId: string): boolean;
}

export interface SkillSessionManagerOptions {
  store?: SkillSessionStore;
  now?: () => number;
  /** Timer scheduler for inactivity expiry; injectable for tests. */
  scheduleTimer?: (fn: () => void, delayMs: number) => unknown;
  spin?: SkillSpinFacade;
}

export class SkillSessionManager {
  private readonly store: SkillSessionStore;
  private readonly now: () => number;
  private readonly scheduleTimer: (fn: () => void, delayMs: number) => unknown;
  private readonly spinOverride?: SkillSpinFacade;
  private readonly active = new Map<string, ActiveBinding>();
  private loaded = false;
  private expiryTimer: unknown | undefined;
  private closed = false;

  constructor(opts?: SkillSessionManagerOptions) {
    this.store = opts?.store ?? new SkillSessionStore();
    this.now = opts?.now ?? Date.now;
    this.scheduleTimer = opts?.scheduleTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.spinOverride = opts?.spin;
  }

  /** Path of the backing store (test visibility). */
  get storePath(): string { return this.store.path; }

  private async spin(): Promise<SkillSpinFacade> {
    if (this.spinOverride) return this.spinOverride;
    return (await import("./spin.js")).spin as unknown as SkillSpinFacade;
  }

  /** Load durable bindings as suspended (no transports). Idempotent. */
  ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.store.load();
    for (const record of this.store.list()) {
      this.active.set(
        scopeKeyOf({ userId: record.userId, platform: record.platform, chatId: record.chatId, threadId: record.threadId }),
        { ...record, needsBootstrap: true },
      );
    }
    if (this.active.size > 0) {
      logInfo(TAG, `Restored ${this.active.size} suspended skill binding(s)`);
    }
    this.armExpiryTimer();
  }

  private armExpiryTimer(): void {
    if (this.closed || this.expiryTimer !== undefined) return;
    this.expiryTimer = this.scheduleTimer(() => {
      this.expiryTimer = undefined;
      this.checkExpiry();
      this.armExpiryTimer();
    }, EXPIRY_CHECK_INTERVAL_MS);
  }

  /** End transports and remove bindings whose inactivity deadline passed. */
  checkExpiry(): void {
    const now = this.now();
    for (const [key, binding] of this.active) {
      if (binding.expiresAt > now) continue;
      logInfo(TAG, `Skill "${binding.skillName}" expired for ${binding.userId} (${binding.platform})`);
      if (binding.sessionId) void this.endTransport(binding, "timeout");
      this.active.delete(key);
      this.store.remove(key);
    }
  }

  private toRecord(binding: ActiveBinding): SkillBindingRecordV1 {
    return {
      version: 1,
      skillName: binding.skillName,
      userId: binding.userId,
      platform: binding.platform,
      chatId: binding.chatId,
      ...(binding.threadId !== undefined ? { threadId: binding.threadId } : {}),
      agent: binding.agent,
      ...(binding.contextPath !== undefined ? { contextPath: binding.contextPath } : {}),
      startedAt: binding.startedAt,
      lastActiveAt: binding.lastActiveAt,
      expiresAt: binding.expiresAt,
    };
  }

  /**
   * Launch or resume K. Validation precedes any replacement. The binding is
   * persisted before the first model call and removed if that call
   * definitively fails. The returned first response belongs to the caller —
   * the manager never sends it and never creates its own settlement.
   */
  async launch(input: SkillLaunchInput): Promise<SkillLaunchResult> {
    this.ensureLoaded();
    const { skill, agent, target, message } = input;
    const key = scopeKeyOf(target);

    // 1. Strict skill load (also serves as replacement validation).
    const loaded = loadSkill(skill, target.userId);
    if (!loaded.ok) {
      return { ok: false, error: { code: loaded.error.code, message: loaded.error.message } };
    }
    const timeoutMs = loaded.skill.config.timeout * 1000;

    // 2. Replacement rules: same skill + same agent reuses; otherwise the new
    //    skill passed validation above, so terminate the old K and rebind.
    const existing = this.active.get(key);
    if (existing && (existing.skillName !== skill || existing.agent !== agent)) {
      logInfo(TAG, `Replacing skill "${existing.skillName}" with "${skill}" for ${target.userId}`);
      if (existing.sessionId) await this.endTransport(existing, "replaced");
      this.active.delete(key);
      this.store.remove(key);
    }

    const now = this.now();
    const record: SkillBindingRecordV1 = {
      version: 1,
      skillName: skill,
      userId: target.userId,
      platform: target.platform,
      chatId: target.chatId,
      ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
      agent,
      ...(loaded.skill.contextPath !== undefined ? { contextPath: loaded.skill.contextPath } : {}),
      startedAt: now,
      lastActiveAt: now,
      expiresAt: now + timeoutMs,
    };
    this.active.set(key, { ...record, needsBootstrap: true });
    this.store.upsert(record);

    const spin = await this.spin();
    let session = existing?.sessionId ? spin.getSessionById(existing.sessionId) : undefined;
    let resumed = existing !== undefined;
    if (!session || session.status === "ended") {
      const created = spin.createSubSession(target.userId, target.platform, "K");
      if (typeof created === "string") {
        this.active.delete(key);
        this.store.remove(key);
        return { ok: false, error: { code: "capacity_exhausted", message: created } };
      }
      session = created;
      session.executionAgent = agent;
    }

    try {
      if (!session.transport) await spin.ensureSessionTransport(session);
    } catch (err) {
      await this.abortLaunch(key, session);
      return {
        ok: false,
        error: { code: "transport_failed", message: err instanceof Error ? err.message : String(err) },
      };
    }

    // 3. First model turn through the real K session.
    const bootstrap = buildBootstrap(skill, loaded.skill.skillMd, loaded.skill.context, message);
    try {
      const result = await spin.spin({
        type: "K",
        sessionId: session.id,
        prompt: bootstrap,
        userId: target.userId,
        settlementOwner: "spin",
        await: true,
      });
      if (!result.result) throw new Error("empty model response");
      const live = this.active.get(key);
      if (live) {
        live.sessionId = session.id;
        live.needsBootstrap = false;
        live.lastActiveAt = this.now();
        live.expiresAt = this.now() + timeoutMs;
        this.store.upsert(this.toRecord(live));
      }
      logInfo(TAG, `Skill "${skill}" ${resumed ? "resumed" : "launched"} for ${target.userId} (${target.platform}:${target.chatId}, session ${session.id})`);
      return { ok: true, kind: resumed ? "resumed" : "launched", sessionId: session.id, response: result.result, skillName: skill };
    } catch (err) {
      await this.abortLaunch(key, session);
      return {
        ok: false,
        error: { code: "transport_failed", message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  /** Remove the just-created binding + K transport after a definitive launch failure. */
  private async abortLaunch(key: string, session: ManagedSession): Promise<void> {
    this.active.delete(key);
    this.store.remove(key);
    const spin = await this.spin();
    spin.finalizeExactSession(session.id, session.userId);
  }

  /**
   * Pipeline bootstrap prep for a suspended K binding: assemble the skill
   * bootstrap block exactly once, prepended by the pipeline to the first
   * resumed turn. Validation failure clears the binding and signals
   * fallback_to_main so the same inbound message reaches A exactly once.
   */
  prepareBootstrap(target: ConversationAddress, message: string):
    | { kind: "bootstrap"; bootstrap: string }
    | { kind: "resumed" }
    | { kind: "fallback_to_main" }
    | { kind: "none" } {
    this.ensureLoaded();
    const key = scopeKeyOf(target);
    const binding = this.active.get(key);
    if (!binding) return { kind: "none" };
    if (!binding.needsBootstrap) return { kind: "resumed" };
    const loaded = loadSkill(binding.skillName, target.userId);
    if (!loaded.ok) {
      logWarn(TAG, `Bootstrap for "${binding.skillName}" failed: ${loaded.error.message} — clearing binding`);
      if (binding.sessionId) void this.endTransport(binding, "rehydration_failed");
      this.active.delete(key);
      this.store.remove(key);
      return { kind: "fallback_to_main" };
    }
    return {
      kind: "bootstrap",
      bootstrap: buildBootstrap(binding.skillName, loaded.skill.skillMd, loaded.skill.context, message),
    };
  }

  /**
   * Route an inbound message: exact binding match selects K; suspended
   * bindings rehydrate (allocation only — no model call, bootstrap is
   * prepended by the pipeline); invalid rehydration falls back to A so the
   * same message is processed exactly once there.
   */
  resolveForInbound(target: ConversationAddress): SkillRouteResult {
    this.ensureLoaded();
    const key = scopeKeyOf(target);
    const binding = this.active.get(key);
    if (!binding) return { kind: "none" };
    if (binding.expiresAt <= this.now()) {
      if (binding.sessionId) void this.endTransport(binding, "timeout");
      this.active.delete(key);
      this.store.remove(key);
      return { kind: "none" };
    }
    if (!binding.sessionId) {
      // Suspended after restart — revalidate before a model turn.
      const loaded = loadSkill(binding.skillName, target.userId);
      if (!loaded.ok) {
        logWarn(TAG, `Rehydration for "${binding.skillName}" failed: ${loaded.error.message} — clearing binding`);
        this.active.delete(key);
        this.store.remove(key);
        return { kind: "fallback_to_main" };
      }
      const created = this.allocateSuspendedK(binding, target.userId, target.platform);
      if (!created) return { kind: "fallback_to_main" };
      binding.sessionId = created.id;
      binding.needsBootstrap = true;
      logInfo(TAG, `Rehydrated skill "${binding.skillName}" for ${target.userId} (session ${created.id}, pending bootstrap)`);
      return { kind: "active", sessionId: created.id, needsBootstrap: true };
    }
    return { kind: "active", sessionId: binding.sessionId, needsBootstrap: binding.needsBootstrap };
  }

  /** Allocate a non-active K for a suspended binding (synchronous facade). */
  private allocateSuspendedK(binding: ActiveBinding, userId: string, platform: string): ManagedSession | null {
    // Synchronous allocation needs the real Spin singleton; the facade's
    // createSubSession is synchronous, so resolve it lazily once.
    const facade = this.spinFacadeSync();
    if (!facade) return null;
    const created = facade.createSubSession(userId, platform, "K");
    if (typeof created === "string") {
      this.active.delete(scopeKeyOf({ userId: binding.userId, platform: binding.platform, chatId: binding.chatId, threadId: binding.threadId }));
      this.store.remove(scopeKeyOf({ userId: binding.userId, platform: binding.platform, chatId: binding.chatId, threadId: binding.threadId }));
      return null;
    }
    created.executionAgent = binding.agent;
    return created;
  }

  private spinFacadeSync(): SkillSpinFacade | undefined {
    if (this.spinOverride) return this.spinOverride;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./spin.js") as typeof import("./spin.js");
      return mod.spin as unknown as SkillSpinFacade;
    } catch { return undefined; }
  }

  /** Refresh inactivity only after an accepted matching K turn. */
  completeInbound(target: ConversationAddress): void {
    const key = scopeKeyOf(target);
    const binding = this.active.get(key);
    if (!binding) return;
    binding.needsBootstrap = false;
    binding.lastActiveAt = this.now();
    const loaded = loadSkill(binding.skillName, target.userId);
    const timeoutMs = loaded.ok ? loaded.skill.config.timeout * 1000 : FALLBACK_TIMEOUT_MS;
    binding.expiresAt = this.now() + timeoutMs;
    this.store.upsert(this.toRecord(binding));
  }

  /**
   * Stop the caller's exact binding. Idempotent — a repeated stop is a no-op.
   * Ends the manager-owned K transport only; A is never touched.
   */
  async stop(target: ConversationAddress, reason: "explicit" | "timeout" | "replaced"): Promise<boolean> {
    this.ensureLoaded();
    const key = scopeKeyOf(target);
    const binding = this.active.get(key);
    if (!binding) return false;
    if (binding.sessionId) await this.endTransport(binding, reason);
    this.active.delete(key);
    this.store.remove(key);
    logInfo(TAG, `Skill "${binding.skillName}" stopped (${reason}) for ${target.userId}`);
    return true;
  }

  /** View for /skill list. */
  list(target: ConversationAddress): SkillBindingView | undefined {
    this.ensureLoaded();
    const key = scopeKeyOf(target);
    const binding = this.active.get(key);
    if (!binding) return undefined;
    return {
      skillName: binding.skillName,
      agent: binding.agent,
      sessionId: binding.sessionId,
      startedAt: binding.startedAt,
      lastActiveAt: binding.lastActiveAt,
      expiresAt: binding.expiresAt,
    };
  }

  /** Graceful shutdown: release transports, retain unexpired durable bindings. */
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const binding of this.active.values()) {
      if (binding.sessionId) await this.endTransport(binding, "shutdown");
    }
  }

  private async endTransport(binding: ActiveBinding, reason: string): Promise<void> {
    const sessionId = binding.sessionId;
    binding.sessionId = undefined;
    if (!sessionId) return;
    try {
      const spin = await this.spin();
      spin.finalizeExactSession(sessionId, binding.userId);
    } catch (err) {
      logWarn(TAG, `Ending K transport ${sessionId} failed (${reason}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Singleton used by the pipeline, scheduled runner, and commands. */
export const skillSessionManager = new SkillSessionManager();

// ── Legacy exported surface (kept for callers; delegates to strict loading) ──

export function listRunnableSkills(): Array<{ name: string; description: string; interactive: boolean }> {
  return listRunnableSkillsStrict();
}
