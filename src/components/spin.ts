/**
 * spin.ts — Unified session router (#943, #953).
 * Single flat Map<sessionId, ManagedSession>. No bucketing. No PlatformState.
 */

import { logInfo, logWarn, logDebug } from "./logger.js";
import { logAndSwallow } from "./log-and-swallow.js";
import { SpinDispatchAdmissionError } from "./spin-types.js";
import { kanbanEnqueue, kanbanRunning, kanbanComplete, kanbanFail, kanbanRetryOrFail, kanbanGetCard, resolveRootId, checkWorkerSlotForProject } from "./tasks/kanban-board.js";
import type { SubagentRuntime, AgentSession } from "./subagent-runtime.js";
import type { IKiroTransport, RuntimeUsageSnapshot } from "./transport/kiro-transport.js";
import type { CancelReason } from "./swarm-executor-types.js";
import { loadUsers } from "./user-registry.js";
import { getMasterUserId } from "./master-user.js";
import type { ManagedSession, SpinRequest, SessionType, SpinSessionSpec, SpinResult, StepEvent, DispatchBackgroundOptions, SpinExecutionDriver, QueuedSessionInstruction } from "./spin-types.js";
import { sessionType } from "./spin-types.js";
import { profileFor, type SessionProfile } from "./spin-profiles.js";
import { WorkerSupervisionService, validateWorkerRootCriteria } from "./worker-supervision-service.js";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import { pushLog, isHollow, cancelSessionExecution, createSpinSessionRegistry, type SpinSessionRegistry } from "./spin-sessions.js";
import { createExecutionSupervisor, type ExecutionSupervisor, SpinBindRejectionError } from "./execution-control.js";
import { createSpinMaintenance, type SpinMaintenance } from "./spin-maintenance.js";
import { leaseInstructions, markDelivered, markConsumed, failAfterDelivery, expireInstructions, restoreBeforeDelivery, subscribeSteerEvents } from "./session-instruction-queue.js";
import { createExecutionTelemetryScope } from "./execution-telemetry.js";
import type { OrcActivityFeed } from "./orc-activity-feed.js";
import type { SessionOutputFeed } from "./session-output-feed.js";
import { createOutputObserver, type OutputObserver } from "./session-output-feed.js";
import { ExecutorProgressEmitter } from "./executor-progress-emitter.js";
import { normalizeContract } from "./worker-contract.js";

export type { ManagedSession, SpinRequest, SessionType } from "./spin-types.js";
export { sessionType, sessionCreatedAt, typeLabel, typeAgent, parseSessionType } from "./spin-types.js";
export { isHollow };

const TAG = "spin";

const USER_SESSION_IDLE_MS = parseInt(process.env["USER_SESSION_IDLE_MS"] ?? "7200000", 10);
const GUEST_SESSION_IDLE_MS = parseInt(process.env["GUEST_SESSION_IDLE_MS"] ?? "1800000", 10);
const MAX_TOTAL_SESSIONS = parseInt(process.env["MAX_TOTAL_SESSIONS"] ?? "12", 10);
const SESSION_CREATE_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

const MAX_STEER_ROUNDS = 10;

const MAX_CONCURRENT: Partial<Record<SessionType, number>> = {
  T: 1, O: 1, B: 1, D: 1, H: 1, W: 3,
};

/** #1540: composed owners behind the Spin facade. */
export interface SpinComponents {
  sessions: SpinSessionRegistry;
  executions: ExecutionSupervisor;
  maintenance: SpinMaintenance;
}

export class Spin {
  private readonly sessions: SpinSessionRegistry;
  private readonly executions: ExecutionSupervisor;
  private readonly maintenance: SpinMaintenance;
  private runtime: SubagentRuntime | null = null;
  private memory: { recordMessage(opts: { role: string; content: string; timestamp: number; userId: string; sessionId: string }): void } | null = null;
  private orcSession: AgentSession | null = null;
  private orcActivityFeed?: OrcActivityFeed;
  private sessionOutputFeed?: SessionOutputFeed;
  /**
   * #1527: late-bound durable context provider holder. Spin forwards its
   * current provider directly instead of scraping an optional transport
   * property (which was never set and produced a circular no-op).
   */
  private contextProvider: import("./transport/pi-core-context.js").DurableContextProviderHolder = { current: null };

  /** #1540: compose the closure-backed owners; tests may inject fresh ones. */
  constructor(components?: Partial<SpinComponents>) {
    this.sessions = components?.sessions ?? createSpinSessionRegistry({ maxTotalSessions: MAX_TOTAL_SESSIONS });
    this.executions = components?.executions ?? createExecutionSupervisor({ maxConcurrent: MAX_CONCURRENT });
    this.maintenance = components?.maintenance ?? createSpinMaintenance({ sessions: this.sessions });
  }

  /** #1540: the shared live execution supervisor (single production instance). */
  get executionSupervisor(): ExecutionSupervisor {
    return this.executions;
  }

  setRuntime(runtime: SubagentRuntime): void { this.runtime = runtime; }
  setContextProvider(holder: import("./transport/pi-core-context.js").DurableContextProviderHolder): void { this.contextProvider = holder; }
  setMemory(memory: Spin["memory"]): void { this.memory = memory; }
  setOrcActivityFeed(feed: OrcActivityFeed): void { this.orcActivityFeed = feed; }
  setSessionOutputFeed(feed: SessionOutputFeed): void { this.sessionOutputFeed = feed; }

  // ── Session CRUD ───────────────────────────────────────────────────────

  getActiveSession(userId: string, platform: string): ManagedSession {
    return this.sessions.getOrCreateActive(userId, platform);
  }

  getActiveSessionId(userId: string, platform: string): string {
    return this.getActiveSession(userId, platform).id;
  }

  createSession(userId: string, platform: string, type: SessionType): ManagedSession | string {
    // Ensure a Main session exists before creating additional ones
    this.getActiveSession(userId, platform);
    return this.sessions.create(userId, platform, type);
  }

  createSubSession(userId: string, platform: string, type: SessionType): ManagedSession | string {
    return this.sessions.createSub(userId, platform, type);
  }

  createHollowSession(userId: string, platform: string, type: SessionType, peer: string, remoteSessionId: string): ManagedSession | string {
    return this.sessions.createHollow(userId, platform, type, 0, peer, remoteSessionId);
  }

  /** Allocate a named Dreamy (D) session upfront for the duration of a sleep cycle (#1280).
   *  Non-active, platform="background" — visible in master /session (showAll) for the full cycle.
   *  Call at sleep start before the first runtime.complete(); the caller holds the returned id
   *  and passes it as sessionId to subsequent spin({ type:"D", sessionId }) calls. */
  allocateDreamySession(name: string): ManagedSession {
    const userId = getMasterUserId();
    const session = this.sessions.allocate({ type: "D", userId, platform: "background", chatId: 0, active: false });
    session.name = name;
    return session;
  }

  /**
   * #1405 — Allocate a non-active, transportless C session for an external Pi
   * execution generation. Visible in global session listing and TUI attachment
   * but has no transport, no idle timeout, and no memory recording.
   */
  allocateExternalSession(spec: {
    type: "C";
    userId: string;
    platform: string;
    name: string;
    workingDir: string;
    metadata: { runId: string; generation: number; executor: string };
  }): ManagedSession {
    const session = this.sessions.allocate({ type: spec.type, userId: spec.userId, platform: spec.platform, chatId: 0, active: false });
    session.name = spec.name;
    session.workingDir = spec.workingDir;
    (session as unknown as Record<string, unknown>).externalMetadata = spec.metadata;
    return session;
  }

  /**
   * #1405 — End an external Pi generation session. Validates the immutable
   * metadata to ensure the caller owns this exact generation.
   */
  endExternalSession(sessionId: string, expected: { runId: string; generation: number }): boolean {
    const session = this.sessions.getById(sessionId);
    if (!session) return false;
    const meta = (session as unknown as Record<string, unknown>).externalMetadata as { runId?: string; generation?: number } | undefined;
    if (!meta || meta.runId !== expected.runId || meta.generation !== expected.generation) return false;
    const r = this.sessions.end(session.userId, session.platform, session.shortIndex);
    if (typeof r === "string") return false;
    this.finalizeSession(r, "external_ended");
    return true;
  }

  switchSession(userId: string, platform: string, index: number): ManagedSession | string {
    return this.sessions.switch(userId, platform, index);
  }

  endSession(userId: string, platform: string, index?: number): ManagedSession | string {
    const r = this.sessions.end(userId, platform, index);
    if (typeof r === "string") return r;
    this.finalizeSession(r, "ended");
    return r;
  }

  killSession(userId: string, platform: string, index: number): ManagedSession | string {
    const r = this.sessions.kill(userId, platform, index);
    if (typeof r === "string") {
      const bg = this.sessions.getByGlobalIndex(index);
      if (bg && bg.userId === userId && bg.platform === "background") {
        this.finalizeSession(bg, "killed");
        return bg;
      }
      return r;
    }
    this.finalizeSession(r, "killed");
    return r;
  }

  /**
   * #1432: End an exact session by ID with ownership check, without session
   * switching or A reconciliation (the skill manager owns K transport
   * lifecycle; A must never be deactivated or recreated by K cleanup).
   * Returns false when the session is missing or owned by another user.
   */
  finalizeExactSession(sessionId: string, expectedUserId: string): boolean {
    const session = this.sessions.getById(sessionId);
    if (!session || session.userId !== expectedUserId) return false;
    if (session.status !== "ended") {
      cancelSessionExecution(session, "session_end");
      this.finalizeSession(session, "skill_ended");
    }
    return true;
  }

  pauseSession(userId: string, platform: string, index?: number): ManagedSession | string {
    return this.sessions.pause(userId, platform, index);
  }

  resumeSession(userId: string, platform: string, index?: number): ManagedSession | string {
    return this.sessions.resume(userId, platform, index);
  }

  listSessions(userId: string, platform: string): { sessions: ManagedSession[]; activeIndex: number } {
    const list = this.sessions.list(userId, platform);
    const active = list.find(s => s.active);
    return { sessions: [...list], activeIndex: active?.shortIndex ?? 0 };
  }

  listAllSessions(): ManagedSession[] {
    return [...this.sessions.listAll()];
  }

  getSessionById(sessionId: string): ManagedSession | undefined {
    return this.sessions.getById(sessionId);
  }

  /**
   * #1534: Interrupt the execution owned by the selected session, resolving
   * the session's own transport first. The supplied fallback (boot/pipeline
   * transport) is used only when the session is absent or transportless, so
   * interactive turns are cancelled on the transport that actually owns
   * them. The session busy flag is cleared only after the interrupt resolves
   * successfully — an interrupt failure must not falsely report idle. This
   * deliberately does NOT call cancelSessionExecution(): that is a terminal
   * lifecycle operation that also releases the session's transport.
   */
  async interruptSession(
    sessionId: string,
    fallback: IKiroTransport,
    reason: CancelReason = "operator",
  ): Promise<void> {
    const session = this.sessions.getById(sessionId);
    const target = session?.transport ?? fallback;
    await target.sendInterrupt(reason);
    if (session) session.busy = false;
  }

  /** #1336: Look up a session by global shortIndex across all platforms. Returns undefined if not found or ended. */
  getSessionByGlobalIndex(index: number): ManagedSession | undefined {
    return this.sessions.getByGlobalIndex(index);
  }

  formatList(userId: string, platform: string, showAll = false): string {
    return this.sessions.format(userId, platform, showAll);
  }

  clearAll(): void { this.sessions.clear(); }

  // ── Interactive session lifecycle ──────────────────────────────────────

  private _greetingSent = false;
  private _greetingAdapter: { injectMessage: (msg: any) => void } | null = null;

  registerMasterSession(opts: { userId: string; chatId: number; platform: string; transport: IKiroTransport }): void {
    const session = this.getActiveSession(opts.userId, opts.platform);
    session.transport = opts.transport;
    session.transportOwner = "bridge";
    session.delivery = "streaming";
    session.idleTimeoutMs = Infinity;
    session.chatId = opts.chatId;
    session.status = "ready";
    session.lastActiveAt = Date.now();
    const t = opts.transport as any;
    session.pid = t?._rawClient?.pid ?? t?.agent?.pid ?? undefined;
    pushLog(session, "master transport attached");
    logInfo(TAG, `Master session registered: ${opts.userId} (${opts.platform}:${opts.chatId}${session.pid ? ` pid=${session.pid}` : ""})`);

    // #980: Fire greeting once adapter is set (deferred via setGreetingAdapter)
    this._masterOpts = { userId: opts.userId, chatId: opts.chatId, platform: opts.platform };
    this.tryFireGreeting();
  }

  /** Set the adapter for boot greeting. Called after platforms are up. */
  setGreetingAdapter(adapter: { injectMessage: (msg: any) => void }): void {
    this._greetingAdapter = adapter;
    this.tryFireGreeting();
  }

  private _masterOpts: { userId: string; chatId: number; platform: string } | null = null;

  private tryFireGreeting(): void {
    if (this._greetingSent || !this._greetingAdapter || !this._masterOpts) return;
    this._greetingSent = true;
    const { userId, chatId, platform } = this._masterOpts;
    const session = this.getActiveSession(userId, platform);
    this.greetSession(session, chatId, userId);
  }

  /** Inject a greeting into an interactive session (A/C only). */
  greetSession(session: ManagedSession, chatId: number, userId: string, adapter?: { injectMessage: (msg: any) => void }): void {
    const type = sessionType(session);
    if (type !== "A" && type !== "C") return;
    if (session.messageCount > 0) return;
    const a = adapter ?? this._greetingAdapter;
    if (!a) return;

    let attempt = 0;
    const inject = (): void => {
      attempt++;
      a.injectMessage({
        platform: session.platform,
        channelId: String(chatId),
        userId,
        senderId: String(chatId),
        senderName: userId,
        text: "[SESSION START] You just came online. Greet the user.",
        timestamp: Date.now(),
        isGroup: false,
        isVoice: false,
      });
      setTimeout(() => {
        if (session.messageCount > 0) return;
        if (session.busy) return;
        if (attempt >= 3) { logWarn(TAG, "Greeting failed after 3 attempts"); return; }
        logWarn(TAG, `Greeting attempt ${attempt}/3 — no response, retrying`);
        inject();
      }, 60_000);
    };

    if (session.transport?.isReady) {
      inject();
    } else if (session.transport) {
      session.transport.onReady = () => inject();
    }
  }

  async resolveSession(userId: string, platform: string, chatId: number): Promise<ManagedSession> {
    const session = this.getActiveSession(userId, platform);

    if (session.status === "paused") throw new Error("Session is paused — use /session resume");
    if (session.status === "ended") throw new Error("Session ended — use /session new");

    if (session.transport) {
      session.lastActiveAt = Date.now();
      return session;
    }

    const total = this.listAllSessions().filter(s => s.transport).length;
    if (total >= MAX_TOTAL_SESSIONS) throw new Error("System busy, try again in a few minutes.");

    session.status = "creating";
    session.chatId = chatId;
    const registry = loadUsers();
    const user = registry.byUserId.get(userId);
    const role = user?.role ?? "guest";
    session.idleTimeoutMs = role === "master" ? Infinity : role === "guest" ? GUEST_SESSION_IDLE_MS : USER_SESSION_IDLE_MS;
    session.delivery = role === "master" ? "streaming" : "simple";

    pushLog(session, `creating transport (${role})`);
    logInfo(TAG, `Creating transport for ${userId} (${role})`);

    try {
      await this._attachRuntimeTransport(session, userId);
      return session;
    } catch (err) {
      this.finalizeSession(session, "creation_failed");
      pushLog(session, `error: ${err instanceof Error ? err.message : String(err)}`);
      logWarn(TAG, `Session creation failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /**
   * #1336: Ensure a transport for an already-selected session by ID.
   * Unlike resolveSession, this does NOT resolve by platform-active session —
   * it operates on the exact session passed in. Reuses an existing transport
   * if present, or creates a new runtime transport for the session.
   */
  async ensureSessionTransport(session: ManagedSession): Promise<void> {
    if (session.transport) {
      session.lastActiveAt = Date.now();
      return;
    }
    if (session.status === "paused") throw new Error("Session is paused — use /session resume");
    if (session.status === "ended") throw new Error("Session ended — use /session new");

    const total = this.listAllSessions().filter(s => s.transport).length;
    if (total >= MAX_TOTAL_SESSIONS) throw new Error("System busy, try again in a few minutes.");

    await this._attachRuntimeTransport(session, session.userId);
  }

  /** Shared — attach a runtime (SubagentRuntime) transport to a session with #1348 ownership metadata. */
  private async _attachRuntimeTransport(session: ManagedSession, userId: string): Promise<void> {
    session.status = "creating";
    // #1432: transport creation/reattachment uses the session's selected agent
    // (recorded for K at allocation), falling back to the type profile. Never
    // hardcode professor and never derive a lifecycle type from an agent name.
    const profile = profileFor(sessionType(session));
    const attachAgent = session.executionAgent ?? profile?.agent ?? "professor";
    let agentSession: import("./subagent-runtime.js").AgentSession;
    try {
      agentSession = await Promise.race([
        this.runtime!.session(attachAgent, userId),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Session creation timed out")), SESSION_CREATE_TIMEOUT_MS)),
      ]);
    } catch (err) {
      this.finalizeSession(session, "transport_attach_failed");
      throw err;
    }
    session.transport = agentSession.transport!;
    session.transportOwner = "runtime";
    session.releaseTransport = () => agentSession.destroy();
    session.executionAgent = attachAgent;
    session.status = "ready";
    session.lastActiveAt = Date.now();
    const t = session.transport as any;
    session.pid = t?._rawClient?.pid ?? t?.agent?.pid ?? undefined;
    pushLog(session, "transport ready");
    logInfo(TAG, `Session ready: ${session.userId} id=${session.id}${session.pid ? ` pid=${session.pid}` : ""}`);
  }

  destroySession(userId: string, sessionId?: string): void {
    for (const s of this.sessions.listAll()) {
      if (s.userId !== userId) continue;
      if (sessionId && s.id !== sessionId) continue;
      if (s.idleTimeoutMs === Infinity) continue;
      this.finalizeSession(s, "destroyed");
      logInfo(TAG, `Session destroyed: ${userId} id=${s.id}`);
    }
  }

  destroyAll(): void {
    for (const s of this.sessions.listAll()) {
      this.finalizeSession(s, "shutdown");
    }
    if (this.orcSession) { try { this.orcSession.destroy(); } catch (err) { logAndSwallow(TAG, "destroy", err); } this.orcSession = null; }
    this.sessions.clear();
    logInfo(TAG, "All sessions destroyed (shutdown)");
  }

  // ── injectGreeting() ───────────────────────────────────────────────────
  // #1106: replaced inject() (which generated a model response but never
  // delivered to the user). injectGreeting routes a synthetic message
  // through the normal pipeline — the model responds AND the response is
  // delivered to the user via the standard adapter.sendMessage path.

  async injectGreeting(userId: string, prompt: string): Promise<string | null> {
    if (!this._greetingAdapter) { logWarn(TAG, "injectGreeting: no adapter"); return null; }
    const registry = loadUsers();
    const user = registry.byUserId.get(userId);
    if (!user) { logWarn(TAG, `inject: unknown user ${userId}`); return null; }
    const chatId = user.platforms.telegram ?? user.platforms.discord;
    if (!chatId) { logWarn(TAG, `inject: no chatId for ${userId}`); return null; }
    const platform = user.platforms.telegram ? "telegram" : "discord";
    this._greetingAdapter.injectMessage({
      platform,
      channelId: String(chatId),
      userId,
      senderId: String(chatId),
      senderName: userId,
      text: prompt,
      timestamp: Date.now(),
      isGroup: false,
      isVoice: false,
    });
    logInfo(TAG, `injectGreeting: routed to pipeline for ${userId}`);
    return "routed";
  }

  // ── Orc ────────────────────────────────────────────────────────────────

  getOrcSession(): AgentSession | null { return this.orcSession?.isReady ? this.orcSession : null; }

  /** @deprecated Use `spin({ type:"O", sessionId, prompt:"[USER] "+msg, await:true })`. */
  async sendUserToOrc(message: string): Promise<string | null> {
    const orcSession = this.sessions.listAll().find(s => s.id.includes("_O_"));
    if (!orcSession) return null;
    const { result } = await this.spin({ type: "O", sessionId: orcSession.id, prompt: `[USER] ${message}`, settlementOwner: "spin", await: true });
    return result ?? null;
  }


  // ── #1271: unified session API ────────────────────────────────────────
  //
  // spin(spec) is the single chokepoint for issuing a model prompt. Per-type
  // behavior lives in SESSION_PROFILES (spin-profiles.ts) — no `type === "…"`
  // branches here. Continuation (pipeline main turn, sleep step N) is just
  // spin() with a sessionId.

  async spin(spec: SpinSessionSpec): Promise<SpinResult> {
    if (!this.runtime) throw new Error("Spin: runtime not set");
    const profile = profileFor(spec.type);

    // #1327: defensive against an unknown SessionType. A kanban card with
    // type="bug" (a ticket category, not a SessionType) used to crash the
    // bridge on `spec.agent ?? profile.agent` because profile was undefined
    // — the unhandled rejection killed the process. Now: log + mark the
    // card failed (if from kanban) + return a sensible empty result. The
    // crash no longer reaches main.ts's unhandledRejection handler.
    if (!profile) {
      const note = `invalid type for Spin dispatch: "${spec.type}" is not a SessionType (#1327)`;
      logWarn(TAG, `spin: no profile for type "${spec.type}" (cardId=${spec.cardId ?? "n/a"}, source=${spec.source ?? "n/a"}) — failing soft`);
      if (spec.cardId !== undefined) {
        try { kanbanFail(spec.cardId, note); } catch { /* best effort */ }
      }
      return {
        sessionId: spec.sessionId ?? "",
        cardId: spec.cardId,
        result: `[SYSTEM BUG] ${note}`,
      };
    }

    // 1. Defaults
    const userId   = spec.userId ?? getMasterUserId();
    const platform = spec.platform ?? "background";
    const chatId   = spec.chatId ?? 0;
    const agent    = spec.agent ?? profile.agent;
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const terminate = spec.terminateAfter ?? profile.terminateAfter;
    const persistent = spec.persistent ?? (profile.transportMode === "persistent");

    // 2. Resolve session (reuse | active | singleton | transient) — driven by profile, no type branches
    let session: ManagedSession;
    if (spec.sessionId) {
      const found = this.sessions.getById(spec.sessionId);
      if (!found) throw new Error(`Spin: sessionId ${spec.sessionId} not found`);
      if (found.status === "ended") throw new Error(`Spin: sessionId ${spec.sessionId} is ended`);
      session = found;
    } else if (spec.active || profile.resolution === "active") {
      session = this.getActiveSession(userId, platform);
    } else if (profile.resolution === "singleton") {
      session = spec.type === "O" && spec.orcContext
        ? this.getOrCreateOrcProjectSession(userId, spec.orcContext.projectCardId)
        : this.getOrCreateVisibleSession(userId, spec.type)!;
    } else {
      session = this.sessions.allocate({ type: spec.type, userId, platform, chatId });
      if (spec.metadata) session.metadata = { ...spec.metadata };
    }
    const stepIndex = (session.messageCount >> 1) + 1;

    // A legacy/user O turn has no project authority. Never inherit the prior
    // project's context when a project-scoped session is reused.
    if (spec.type === "O" && !spec.orcContext) session.orcContext = undefined;

    // #1332: Assign execution generation for steering continuity
    session.activeExecutionId = `${session.id}_${stepIndex}_${Date.now()}`;
    // #1502 §7: attach the caller-supplied execution control to the session so
    // killSession/endSession/shutdown can reach it without knowing the caller.
    // #1540: the supervisor binds at most one active generation per session —
    // a stale generation can never cancel, settle, or release its successor.
    // A rejected bind surfaces as one typed facade failure; the session keeps
    // its existing control and no execution starts unbound.
    if (spec.executionControl) {
      const bound = this.executions.bindSession(spec.executionControl.executionRef, session.id);
      if (!bound) {
        throw new SpinBindRejectionError(
          spec.executionControl.executionRef,
          session.id,
          this.executions.getForSession(session.id)?.executionRef,
        );
      }
      session.executionControl = spec.executionControl;
    }

    // #1444: Execution telemetry scope — tracks provider calls for this generation
    const executionTelemetry = createExecutionTelemetryScope(session.activeExecutionId);

    // 3. Kanban card (user-facing work only)
    let cardId = spec.cardId;
    if (cardId === undefined && spec.goal !== undefined) {
      cardId = kanbanEnqueue(spec.title ?? spec.goal.slice(0, 80), spec.source ?? "user", undefined, {
        priority: spec.priority ?? "MEDIUM", type: spec.type, parent_id: spec.parentCardId,
        deliveryMode: spec.deliveryMode, delivery: spec.delivery, chatId: chatId ? String(chatId) : undefined,
        notes: spec.callbackPeer ? JSON.stringify({ callback_peer: spec.callbackPeer }) : undefined,
        sourcePeer: spec.sourcePeer,
        deliveryReady: spec.deliveryReady,
      });
    }
    // The scheduled runner may need to settle a timeout before dispatchAwait
    // returns its card ID. Publish the allocated card to the shared execution
    // control at the earliest point so forced settlement can fail it exactly
    // once instead of leaving it running.
    if (cardId !== undefined) spec.executionControl?.setCardId(cardId);
    if (cardId !== undefined && this.executions.admit(spec.type, cardId)) {
      kanbanRunning(cardId);
    }

    // #1319: Track card association and publish execution.started for Orc
    if (cardId !== undefined && spec.type === "O") {
      session.activeCardId = cardId;
      session.activeRootCardId = resolveRootId(cardId);
      this.orcActivityFeed?.publish({
        kind: "execution.started",
        timestamp: Date.now(),
        sessionId: session.id,
        executionId: session.activeExecutionId!,
        rootCardId: session.activeRootCardId,
        cardId,
      } as Parameters<NonNullable<typeof this.orcActivityFeed>["publish"]>[0]);
    }

    // 4-7. Single try/catch so EVERY exit path (pre-exec throws included) flows
    //       through failSpin, which owns markDone + drainQueued. Without this,
    //       a throw from beforePrompt / transport creation / a decorator leaves
    //       the cardId in this.running forever, wedging single-slot types
    //       (O/T/B/D/H) until bridge restart. (#1274)
    const started = Date.now();
    try {
      // #1480: bind the durable run before any decorator, tool, or provider work.
      // A failed/stale bind must never start a model turn under an unowned project.
      if (spec.type === "O" && spec.orcContext) {
        session.orcContext = spec.orcContext;
        const { OrcProjectRunStore } = await import("./orc-project/orc-project-run-store.js");
        const bind = new OrcProjectRunStore().bindExecution(spec.orcContext, session.id, session.activeExecutionId!);
        if (!bind.ok) throw new Error(`Orc bindExecution rejected: ${bind.reason}`);
        session.orcContext = {
          ...spec.orcContext,
          sessionId: session.id,
          executionId: session.activeExecutionId,
        };
      }
      // 4. before-hook
      await profile.beforePrompt?.(session, cardId);

      // 5. Resolve the execution transport. Reuse the session's OWN transport if it
      //    already has one (A per-user main turn, D step N, O reuse). Only
      //    create+attach for a NEW persistent session.
      let sessionTransport = session.transport as IKiroTransport | undefined;
      if (persistent && !sessionTransport) {
        // #1432: reattachment honors the selected executionAgent recorded at
        // allocation (K) so a resumed session keeps its model configuration.
        const attachAgent = session.executionAgent ?? agent;
        const agentSession = await this.runtime.session(attachAgent, profile.resolution === "active" ? userId : undefined);
        sessionTransport = agentSession.transport as IKiroTransport;
        session.transport = sessionTransport;
        session.transportOwner = "runtime";
        session.releaseTransport = () => agentSession.destroy();
        session.executionAgent = attachAgent;
        session.status = "ready";
      }

      // 6. Build prompt via decorators
      let prompt = spec.prompt ?? spec.goal ?? "";
      for (const decorate of profile.decorators) {
        prompt = await decorate(prompt, { session, cardId, parentCardId: spec.parentCardId });
      }
      // #1366: Inject Worker contract into prompt when contractId is set
      if (spec.contractId && cardId !== undefined) {
        try {
          const sup = new WorkerSupervisionService();
          const contract = sup.getContract(spec.contractId);
          if (contract) {
            prompt = sup.renderContractForPrompt(contract) + "\n\n" + prompt;
          }
        } catch { /* best effort — non-supervised cards pass through unchanged */ }
      }
      pushLog(session, `spin type=${spec.type} agent=${agent} step=${stepIndex}`);

      // 7. Execute — persistent/continuation sends via the session's own transport
      //    (key = session.id preserves the Orc sneak-in); oneshot uses runtime.complete.
      //    #1529: thread the explicit durable-context intent through unchanged so
      //    the transport can fail closed when a required durable cursor is
      //    unavailable, or bound its DB-backed context assembly to history only.
      //    #1332: wrap with steering continuation loop for persistent sessions.
      const promptContext: import("./transport/kiro-transport.js").PromptRequestContext = {
        userId: spec.userId ?? userId,
        durableContextIntent: spec.durableContextIntent,
        directContextTurn: spec.directContextTurn,
        executionScope: spec.executionScope,
        deadlineAt: spec.deadlineAt,
        orcContext: session.orcContext,
        executionTelemetry,
        // #1527: Spin forwards its own provider reference (late-bound holder
        // populated by boot composition), never a scraped transport property.
        contextProvider: this.contextProvider.current ?? undefined,
      };
      const leaseEmitter = spec.attemptId && spec.executionControl?.generation !== undefined
        ? new ExecutorProgressEmitter()
        : undefined;
      let leaseOutputUnits = 0;
      let leaseToolOrdinal = 0;
      const makeOutputObserver = (): OutputObserver => {
        const base: OutputObserver = this.sessionOutputFeed
          ? createOutputObserver(this.sessionOutputFeed, {
            sessionId: session.id,
            executionId: session.activeExecutionId!,
          })
          : {};
        if (!leaseEmitter) return base;
        return {
          ...base,
          onDelta: (event) => {
            base.onDelta?.(event);
            if (event.kind !== "text" || !event.text) return;
            leaseOutputUnits += Math.max(1, Buffer.byteLength(event.text, "utf8"));
            leaseEmitter.emitOutput(spec.attemptId!, spec.executionControl!.generation!, "spin-local", leaseOutputUnits, `output:${session.activeExecutionId}:${leaseOutputUnits}`);
          },
          onToolStart: (event) => {
            base.onToolStart?.(event);
            leaseToolOrdinal++;
            leaseEmitter.emitToolStart(spec.attemptId!, spec.executionControl!.generation!, "spin-local", `tool:${session.activeExecutionId}:${leaseToolOrdinal}`, event.name);
          },
          end: (reason) => base.end?.(reason),
          invalidate: () => base.invalidate?.(),
        };
      };
      // #1338: wrap each model call/round in a fresh call-local observer so the
      // output feed receives a unique stream per turn. The observer publishes
      // `start` on creation and `end`+invalidate on every exit path; the
      // transport invokes onDelta/onToolStart during streaming.
      const observe = async (
        transport: IKiroTransport,
        key: string,
        msg: string,
        image?: { mime: string; base64: string },
        ctx?: import("./transport/kiro-transport.js").PromptRequestContext,
      ): Promise<string> => {
        if ((!this.sessionOutputFeed && !leaseEmitter) || !session.activeExecutionId) {
          return await transport.sendPrompt(key, msg, image, ctx);
        }
        const obs = makeOutputObserver();
        const enriched = { ...(ctx ?? {}), outputObserver: obs };
        let result: string;
        try {
          result = await transport.sendPrompt(key, msg, image, enriched);
          obs.end?.("complete");
        } catch (err) {
          obs.end?.("error");
          throw err;
        } finally {
          obs.invalidate?.();
        }
        return result;
      };
      // #1361: Resolve a continuation-capable execution driver for this session.
      // Persistent sessions wrap the existing session transport; one-shot sessions
      // open a fresh RuntimeExecution handle keyed by session.id.
      const resolveDriver = async (): Promise<SpinExecutionDriver> => {
        if (sessionTransport) {
          return {
            send: (msg, img, ctx) => observe(sessionTransport!, session.id, msg, img, {
              ...(ctx ?? {}),
              contextProvider: ctx?.contextProvider ?? this.contextProvider.current ?? undefined,
            }),
            steer: typeof sessionTransport.steer === "function"
              ? (content, lease) => sessionTransport!.steer!(content, lease)
              : undefined,
            close: async () => {},
            ephemeral: false,
          };
        }
        const executor = await this.runtime!.openExecution(agent, session.id, {
          timeoutMs, session: "fresh", maxToolRounds: spec.maxToolRounds,
        });
        // #1248: Bind execution control to runtime cancel mechanism
        if (spec.executionControl) {
          spec.executionControl.bind(async (reason) => {
            await executor.cancel(reason);
          });
        }
        sessionTransport = executor.transport as IKiroTransport;
        session.transport = sessionTransport;
        session.transportOwner = "runtime";
        session.releaseTransport = () => executor.close();
        return {
          send: async (msg, img, ctx) => {
            const enrichedContext = {
              ...(ctx ?? {}),
              contextProvider: ctx?.contextProvider ?? this.contextProvider.current ?? undefined,
            };
            if ((!this.sessionOutputFeed && !leaseEmitter) || !session.activeExecutionId) {
              return (await executor.send(msg, img, enrichedContext)) || "(no output)";
            }
            const obs = makeOutputObserver();
            const enriched = { ...(ctx ?? {}), outputObserver: obs };
            try {
              const r = (await executor.send(msg, img, { ...enrichedContext, ...enriched })) || "(no output)";
              obs.end?.("complete");
              return r;
            } catch (err) {
              obs.end?.("error");
              throw err;
            } finally {
              obs.invalidate?.();
            }
          },
          steer: typeof sessionTransport.steer === "function"
            ? (content, lease) => sessionTransport!.steer!(content, lease)
            : undefined,
          close: async () => {
            await executor.close();
            sessionTransport = undefined;
          },
          ephemeral: true,
        };
      };
      const executeWithSteering = async (): Promise<string> => {
        const driver = await resolveDriver();
        // #1531: for a native-steering driver, subscribe BEFORE opening
        // steering acceptance so a same-tick steer.queued is never missed.
        const pump = driver.steer ? this.createNativeSteeringPump(session, driver) : null;
        if (!pump) session.steeringAccepting = true;
        try {
          if (pump) {
            // Native path (#1531): the initial send stays active through all
            // Pi-generated turns and owns the final response. The event-driven
            // pump leases instructions and hands them to the active execution
            // while the send is in flight; its result never replaces the send
            // result and a steering-only failure never replaces the send error.
            try {
              const result = (await driver.send(prompt, spec.imageContent as { mime: string; base64: string } | undefined, promptContext)) || "(no output)";
              await pump.settle();
              return result;
            } catch (sendErr) {
              await pump.settle();
              throw sendErr;
            }
          }
          // Sequential path (ACP/tmux): no in-process agent queue; instructions
          // queued during the send are drained as post-send continuations.
          let result = (await driver.send(prompt, spec.imageContent as { mime: string; base64: string } | undefined, promptContext)) || "(no output)";
          for (let round = 0; round < MAX_STEER_ROUNDS; round++) {
            const batch = leaseInstructions(session, "steer");
            if (!batch) { session.steeringAccepting = false; break; }
            try {
              const steeringPrompt = renderSteeringContinuation(batch.instructions as QueuedSessionInstruction[]);
              markDelivered(batch);
              result = (await driver.send(steeringPrompt, undefined, {
                userId: spec.userId ?? userId,
                executionTelemetry,
                orcContext: session.orcContext,
              })) || "(no output)";
              markConsumed(batch, session);
            } catch (steerErr) {
              if (batch.instructions.some((instruction) => instruction.state === "delivered")) {
                failAfterDelivery(batch, session, "steer_failed");
              } else {
                failAfterDelivery(batch, session, "steer_handoff_failed");
              }
              throw steerErr;
            }
          }
          session.steeringAccepting = false;
          if (session.instructionQueue.length > 0) expireInstructions(session, "round_limit");
          return result;
        } finally {
          await driver.close();
        }
      };

      if (!spec.await) {
        executeWithSteering().then(r => {
          const telemetryUsage = executionTelemetry.snapshot();
          executionTelemetry.close();
          return this.finishSpin(spec, profile, session, cardId, stepIndex, started, r, terminate, telemetryUsage);
        }).catch(e => {
          const telemetryUsage = executionTelemetry.snapshot();
          executionTelemetry.close();
          this.failSpin(spec, profile, session, cardId, stepIndex, started, e, terminate, telemetryUsage);
        });
        return { sessionId: session.id, cardId };
      }
      const result = await executeWithSteering();
      const telemetryUsage = executionTelemetry.snapshot();
      executionTelemetry.close();
      await this.finishSpin(spec, profile, session, cardId, stepIndex, started, result, terminate, telemetryUsage);
      return { sessionId: session.id, cardId, result };
    } catch (err) {
      const telemetryUsage = executionTelemetry.snapshot();
      executionTelemetry.close();
      // Covers: pre-exec throws (steps 4-6) AND awaited execution failures (step 7).
      // failSpin calls markDone + drainQueued — concurrency slot always released.
      await this.failSpin(spec, profile, session, cardId, stepIndex, started, err, terminate, telemetryUsage);
      if (spec.await) {
        // #1502: surface the cardId on rejection so caller-owned settlers (the
        // scheduled-task runner) can fail the Kanban card. Under caller ownership
        // failSpin skips kanbanRetryOrFail, so without this the card would be
        // orphaned in "running" whenever dispatchAwait rejects.
        if (cardId !== undefined && err instanceof Error && !(err as { cardId?: number }).cardId) {
          (err as Error & { cardId?: number }).cardId = cardId;
        }
        throw err;                    // awaited callers still see the error
      }
      return { sessionId: session.id, cardId };     // fire-and-forget: recorded, no unhandled rejection
    }
  }

  /**
   * #1531: Event-driven, serialized native steering pump.
   *
   * Owns a scoped `subscribeSteerEvents` subscription for the current
   * execution generation, FIFO leasing, the native-handoff round counter, and
   * idempotent closing. It runs concurrently with the initial `driver.send()`
   * promise; the send remains the sole source of the final response and the
   * pump only acknowledges leases. No timers or polling — every kick is the
   * synchronous `steer.queued` event, and async functions execute through
   * their first await during the callback so the transport claims the active
   * host before the queue operation returns.
   */
  private createNativeSteeringPump(session: ManagedSession, driver: SpinExecutionDriver): { settle: () => Promise<void> } {
    const executionId = session.activeExecutionId ?? "";
    let activeLease: import("./spin-types.js").InstructionLease | null = null;
    let closing = false;
    let rounds = 0;
    let pumpPromise: Promise<void> | null = null;

    const drain = async (): Promise<void> => {
      while (!closing) {
        if (activeLease) return;          // one native handoff at a time
        if (rounds >= MAX_STEER_ROUNDS) { // round limit reached
          session.steeringAccepting = false;
          if (session.instructionQueue.length > 0) expireInstructions(session, "round_limit");
          return;
        }
        const batch = leaseInstructions(session, "steer");
        if (!batch) return;
        rounds++;
        if (rounds >= MAX_STEER_ROUNDS) session.steeringAccepting = false;
        activeLease = batch;
        try {
          const steeringPrompt = renderSteeringContinuation(batch.instructions as QueuedSessionInstruction[]);
          await driver.steer!(steeringPrompt, batch);
        } catch (steerErr) {
          // A steering-only failure publishes its acknowledgement and stays
          // logged, but must never replace the send result/error. The lease is
          // terminal once delivered; before delivery it is restored so closing
          // or round-limit cleanup can expire it exactly once.
          if (batch.instructions.some((i) => i.state === "delivered")) {
            failAfterDelivery(batch, session, "steer_failed");
          } else {
            restoreBeforeDelivery(batch);
          }
          logWarn(TAG, `Native steering round ${rounds} failed: ${steerErr instanceof Error ? steerErr.message : String(steerErr)}`);
        } finally {
          activeLease = null;
        }
      }
    };

    const run = (): void => {
      if (pumpPromise) return;
      pumpPromise = drain().finally(() => { pumpPromise = null; });
    };

    // Subscribe BEFORE opening acceptance: an instruction accepted while the
    // driver is still opening must be visible to this pump, never dropped.
    const unsub = subscribeSteerEvents({ sessionId: session.id, executionId }, (event) => {
      if (event.type !== "steer.queued" || closing) return;
      if (activeLease) return;            // the running drain loop picks up successors
      run();
    });
    session.steeringAccepting = true;

    return {
      settle: async () => {
        if (closing) return;              // idempotent — exactly one cleanup
        closing = true;
        session.steeringAccepting = false;
        if (pumpPromise) {
          try { await pumpPromise; } catch { /* drain never rejects */ }
        }
        if (session.instructionQueue.length > 0) expireInstructions(session, "execution_ended");
        unsub();
      },
    };
  }

  private async finishSpin(
    spec: SpinSessionSpec, profile: SessionProfile, session: ManagedSession,
    cardId: number | undefined, stepIndex: number, started: number, result: string,
    terminate: "call" | "response" | "external",
    telemetryUsage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  ): Promise<void> {
    // #1444: prefer telemetry scope aggregate (spans all tool rounds + continuations),
    // then transport lastUsage(), then runtime fallback.
    const status = (session.transport as { getRuntimeStatus?: () => { lastTurnUsage?: RuntimeUsageSnapshot } } | undefined)?.getRuntimeStatus?.();
    const fallbackUsage = status?.lastTurnUsage
      ?? (session.transport as { lastUsage?: () => RuntimeUsageSnapshot | null } | undefined)?.lastUsage?.()
      ?? this.runtime?.lastUsage ?? null;
    const usage = telemetryUsage ?? fallbackUsage;
    session.messageCount += 2;
    session.lastActiveAt = Date.now();
    if (usage) {
      session.lastTurnUsage = { ...usage };
      session.sessionUsage = {
        input: (session.sessionUsage?.input ?? 0) + usage.input,
        output: (session.sessionUsage?.output ?? 0) + usage.output,
        cacheRead: session.sessionUsage?.cacheRead !== undefined || usage.cacheRead !== undefined
          ? (session.sessionUsage?.cacheRead ?? 0) + (usage.cacheRead ?? 0) : undefined,
        cacheWrite: session.sessionUsage?.cacheWrite !== undefined || usage.cacheWrite !== undefined
          ? (session.sessionUsage?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0) : undefined,
      };
      session.tokenCount = usage.input + usage.output;
    }
    pushLog(session, "complete");

    if (this.memory) {
      const sid = cardId !== undefined ? `${spec.type}_card${cardId}` : `${spec.type}_${session.id}`;
      this.memory.recordMessage({ role: "user", content: spec.goal ?? spec.prompt ?? "", timestamp: Date.now(), userId: "system", sessionId: sid });
      this.memory.recordMessage({ role: "assistant", content: result, timestamp: Date.now(), userId: "system", sessionId: sid });
    }
    if (cardId !== undefined) {
      // #1248: If cancellation already won, skip normal completion settlement
      if (spec.executionControl?.terminal) {
        logInfo(TAG, `Card ${cardId}: execution control already terminal — skipping finishSpin settlement`);
        this.executions.release(spec.type, cardId);
        return;
      }

      let artifacts: Array<{ name: string; content: string }> = [];
      try {
        const { drainArtifacts } = require("./transport/artifact-tools.js") as typeof import("./transport/artifact-tools.js");
        artifacts = drainArtifacts(cardId) ?? [];
      } catch { /* artifact-tools unavailable (e.g. test env) — skip */ }
      // #1366: Collect evidence and settle for supervised Workers
      let workerSummary = result.slice(0, 500);
      let staleWorkerResult = false;
      if (spec.contractId || spec.type === "W") {
        try {
          const svc = new WorkerSupervisionService();
          const generation = spec.executionControl?.generation;
          const outcome = svc.collectAndSettle(cardId, result, session.workingDir, spec.attemptId, generation, usage ?? undefined);
          if (outcome.settled) {
            workerSummary = outcome.summary;
            if (spec.executionControl) {
              spec.executionControl.markTerminal(outcome.envelope ? "completed" : "failed");
            }
          } else if (outcome.stale) {
            staleWorkerResult = true;
            if (outcome.budgetViolation && spec.settlementOwner !== "caller") {
              kanbanRetryOrFail(cardId, outcome.summary);
            }
            logWarn(TAG, `Card ${cardId}: ${outcome.budgetViolation ? "budget-violating" : "stale"} Worker result ignored (attempt=${spec.attemptId ?? "unknown"})`);
          }
        } catch (err) {
          if (spec.contractId) {
            staleWorkerResult = true;
            logWarn(TAG, `Card ${cardId}: evidence settlement failed — blocking kanbanComplete: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      // #1363 Task 10: supervised O-cards own their lifecycle via projectStateToKanban.
      // Do not let finishSpin prematurely mark them done — the reconciler decides terminal state.
      let shouldKanbanComplete = true;
      let supervisedProject = false;
      if (spec.type === "O") {
        try {
          const { ProjectReviewStore } = require("./project-acceptance/project-review-store.js") as typeof import("./project-acceptance/project-review-store.js");
          const store = new ProjectReviewStore();
          supervisedProject = Boolean(store.getSupervision(cardId));
          shouldKanbanComplete = !supervisedProject;
        } catch (err) {
          // Fail closed: an O-card whose supervision state cannot be read must
          // never be completed or reported as successful by the executor.
          shouldKanbanComplete = false;
          supervisedProject = true;
          logWarn(TAG, `Card ${cardId}: cannot verify project supervision — deferring terminal settlement: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
          if (shouldKanbanComplete && !staleWorkerResult && spec.settlementOwner !== "caller") {
        kanbanComplete(cardId, null, workerSummary);
      }
      // Supervised project results are emitted by ProjectReviewService only
      // after accepted settlement commits. The execution turn must not send a
      // premature peer "done" callback.
      if (spec.callbackPeer && !supervisedProject) {
        const card = kanbanGetCard(cardId);
        fireCallback(spec.callbackPeer, cardId, "done", result.slice(0, 500), undefined, artifacts, card?.tokens_used ?? 0);
      }
    }

    // #1319: Publish execution.completed before clearing association
    if (spec.type === "O" && session.activeExecutionId) {
      this.orcActivityFeed?.publish({
        kind: "execution.completed",
        summary: result.slice(0, 200),
        timestamp: Date.now(),
        sessionId: session.id,
        executionId: session.activeExecutionId,
        rootCardId: session.activeRootCardId,
        cardId: session.activeCardId,
      } as Parameters<NonNullable<typeof this.orcActivityFeed>["publish"]>[0]);
    }
    session.activeExecutionId = undefined;
    session.activeCardId = undefined;
    session.activeRootCardId = undefined;

    await profile.afterPrompt?.(session, cardId);

    // #1480: Release Orc run after successful turn
    if (session.orcContext) {
      try {
        const { OrcProjectRunStore } = await import("./orc-project/orc-project-run-store.js");
        new OrcProjectRunStore().release(session.orcContext, "completed");
      } catch (err) { logWarn(TAG, `Orc release error: ${err instanceof Error ? err.message : String(err)}`); }
    }

    const stepEvent: StepEvent = {
      sessionId: session.id, cardId, stepIndex, result,
      durationMs: Date.now() - started,
      inputTokens: usage?.input, outputTokens: usage?.output,
    };
    await spec.onStepComplete?.(stepEvent);

    this.applyTerminate(session, terminate);
    if (cardId !== undefined) { this.executions.release(spec.type, cardId); this.executions.drainLegacyQueued((request) => this.dispatch(request)); }
  }

  private async failSpin(
    spec: SpinSessionSpec, profile: SessionProfile, session: ManagedSession,
    cardId: number | undefined, stepIndex: number, started: number, err: unknown,
    terminate: "call" | "response" | "external",
    telemetryUsage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  ): Promise<void> {
    // #1332: Expire remaining queued instructions when execution fails
    if (session.instructionQueue.length > 0) expireInstructions(session, "execution_failed");

    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    const errorKind = err instanceof Error ? err.name : typeof err;
    logWarn(TAG, `${spec.type} spin failed (error=${errorKind}, error_chars=${msg.length})`);
    pushLog(session, `failed (${errorKind})`);
    let staleWorkerFailure = false;
    if (cardId !== undefined) {
      // #1248: If terminal already won (cancellation), skip fail settlement
      if (spec.executionControl?.terminal) {
        logInfo(TAG, `Card ${cardId}: execution control already terminal — skipping failSpin settlement`);
        this.executions.release(spec.type, cardId);
        return;
      }
      if (spec.attemptId) {
        try {
          const store = new WorkerSupervisionStore();
          const attempt = store.getAttempt(spec.attemptId);
          const latest = store.getLatestAttempt(cardId);
          const generationMatches = spec.executionControl?.generation === undefined
            || attempt?.generation === spec.executionControl.generation;
          if (!attempt || !latest || latest.id !== attempt.id || !generationMatches) {
            staleWorkerFailure = true;
            logWarn(TAG, `Card ${cardId}: stale Worker failure ignored (attempt=${spec.attemptId})`);
          } else {
            store.terminalSettlement({
              attemptId: spec.attemptId,
              expectedGeneration: attempt.generation || 1,
              desiredState: "failed",
              stableReason: "worker_execution_failed",
              normalizedUsage: telemetryUsage
                ? { input: telemetryUsage.input, output: telemetryUsage.output, trustworthy: true }
                : undefined,
            });
            spec.executionControl?.markTerminal("failed");
          }
        } catch (settlementErr) {
          logWarn(TAG, `Card ${cardId}: failure settlement failed: ${settlementErr instanceof Error ? settlementErr.message : String(settlementErr)}`);
        }
      }
      if (!staleWorkerFailure && spec.settlementOwner !== "caller") {
        kanbanRetryOrFail(cardId, msg);
        if (spec.callbackPeer) fireCallback(spec.callbackPeer, cardId, "failed", undefined, msg);
      }
    }

    // #1319: Publish execution.failed before clearing association
    if (spec.type === "O" && session.activeExecutionId) {
      this.orcActivityFeed?.publish({
        kind: "execution.failed",
        error: msg,
        timestamp: Date.now(),
        sessionId: session.id,
        executionId: session.activeExecutionId,
        rootCardId: session.activeRootCardId,
        cardId: session.activeCardId,
      } as Parameters<NonNullable<typeof this.orcActivityFeed>["publish"]>[0]);
    }
    session.activeExecutionId = undefined;
    session.activeCardId = undefined;
    session.activeRootCardId = undefined;

    await profile.afterPrompt?.(session, cardId);

    // #1480: Release Orc run after failed turn
    if (session.orcContext) {
      try {
        const { OrcProjectRunStore } = await import("./orc-project/orc-project-run-store.js");
        new OrcProjectRunStore().release(session.orcContext, "failed");
      } catch (err) { logWarn(TAG, `Orc release error: ${err instanceof Error ? err.message : String(err)}`); }
    }

    const stepEvent: StepEvent = {
      sessionId: session.id, cardId, stepIndex,
      error: err instanceof Error ? err : new Error(msg),
      durationMs: Date.now() - started,
    };
    await spec.onStepComplete?.(stepEvent);

    this.applyTerminate(session, terminate);
    if (cardId !== undefined) { this.executions.release(spec.type, cardId); this.executions.drainLegacyQueued((request) => this.dispatch(request)); }
  }

  private releaseSessionTransport(session: ManagedSession): void {
    if (session.transportOwner === "runtime" && session.releaseTransport) {
      try { void session.releaseTransport(); } catch (err) { logAndSwallow(TAG, "releaseTransport", err); }
    }
    session.transportOwner = undefined;
    session.releaseTransport = undefined;
    session.transport = undefined;
  }

  private applyTerminate(session: ManagedSession, terminate: "call" | "response" | "external"): void {
    if (terminate === "call") { this.finalizeSession(session, "call_terminated"); this.sessions.remove(session.id); }
    else if (terminate === "response") { this.finalizeSession(session, "response_terminated"); }
    // "external" → stays alive (Orc, persistent D); 1hr housekeeping prunes ended ones
  }

  /** #1271: Background one-shot (e.g. compaction summary). Returns the result string. */
  async dispatchBackground(opts: DispatchBackgroundOptions): Promise<string> {
    const { result } = await this.spin({
      type: opts.type ?? "S",
      prompt: opts.prompt,
      timeoutMs: opts.timeoutMs,
      agent: opts.agent,
      settlementOwner: "spin",
      await: true,
    });
    return result ?? "";
  }

  // ── Dispatch (legacy wrappers, #1271) ───────────────────────────────────
  // dispatch / dispatchAwait / getOrCreateOrc / sendUserToOrc are thin wrappers
  // around the unified spin(spec) chokepoint. dispatchBackground is the new
  // background-only entry point.

  /** #1010: O-type reuses existing session (one Orc). All others create new. */
  private getOrCreateVisibleSession(userId: string, type: SessionType): ManagedSession | undefined {
    if (type === "O") {
      const existing = this.sessions.listAll().find(s => s.id.includes("_O_"));
      if (existing) return existing;
    }
    const sub = this.createSubSession(userId, "telegram", type);
    return typeof sub === "string" ? undefined : sub;
  }

  private getOrCreateOrcProjectSession(userId: string, projectCardId: number): ManagedSession {
    const existing = this.sessions.listAll().find((s) =>
      s.id.includes("_O_") && s.orcContext?.projectCardId === projectCardId);
    if (existing) return existing;
    const sub = this.createSubSession(userId, "background", "O");
    if (typeof sub === "string") throw new Error(sub);
    return sub;
  }

  /**
   * @deprecated Use `spin({ type, goal, …, await: false })` instead.
   * Backward-compat wrapper: creates a kanban card, then dispatches via spin().
   * Returns the cardId synchronously; the model call runs in the background.
   */
  dispatch(request: SpinRequest): { cardId: number; sessionId?: string } {
    // Pre-create the card (matches old behavior — card exists even if blocked)
    const cardTitle = request.title ?? request.goal.slice(0, 80);
    const cardId = request.cardId ?? kanbanEnqueue(cardTitle, request.source, undefined, {
      priority: request.priority ?? "MEDIUM", type: request.type,
      parent_id: request.parentCardId, deliveryMode: request.deliveryMode, delivery: request.delivery,
      notes: request.callbackPeer ? JSON.stringify({ callback_peer: request.callbackPeer }) : undefined,
      chatId: request.chatId, sourcePeer: request.sourcePeer,
    });

    // Concurrency gate: blocked cards stay queued for drainQueued() to pick up.
    // Session cap: also gate here so a full Map never generates a void-spin
    // unhandled rejection (step-2 throws in spin() are outside the try/catch). (#1274)
    const aliveSessions = this.sessions.listAll().length;
    if (aliveSessions >= MAX_TOTAL_SESSIONS || !this.executions.canAdmit(request.type, cardId)) {
      const reason = aliveSessions >= MAX_TOTAL_SESSIONS ? "session cap" : "concurrency gate";
      logInfo(TAG, `${request.type} card:${cardId} queued (${reason})`);
      return { cardId };
    }

    void this.spin({
      type: request.type,
      goal: request.goal,
      cardId,
      parentCardId: request.parentCardId,
      title: request.title,
      priority: request.priority as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | undefined,
      source: request.source,
      deliveryMode: request.deliveryMode,
      delivery: request.delivery,
      agent: request.agent,
      timeoutMs: request.timeoutMs,
      callbackPeer: request.callbackPeer,
      sourcePeer: request.sourcePeer,
      chatId: request.chatId ? Number(request.chatId) : undefined,
      await: false,
      contractId: request.contract?.id,
      attemptId: request.attemptId,
      executionControl: request.executionControl,
      settlementOwner: request.settlementOwner,
      executionScope: request.executionScope,
      deadlineAt: request.deadlineAt,
      deliveryReady: request.deliveryReady,
    });
    return { cardId };
  }

  /**
   * @deprecated Use `spin({ type, goal, …, await: true })` instead.
   * Backward-compat wrapper: synchronously dispatches and returns the result.
   */
  async dispatchAwait(request: SpinRequest): Promise<{ cardId: number; result: string }> {
    // #987: enforce concurrency + cooldown gates
    // #1274: also enforce session cap (await:true — throw is safe, caller awaits)
    // #1520: typed admission rejection so the scheduler can defer the same
    // occurrence instead of counting a failure. Gate checks happen strictly
    // before any model call starts.
    const aliveSessions = this.sessions.listAll().length;
    if (aliveSessions >= MAX_TOTAL_SESSIONS) {
      throw new SpinDispatchAdmissionError("session_capacity", "System busy — max sessions reached.");
    }
    if (!this.executions.canAdmit(request.type, 0)) {
      if (request.type === "H" && this.executions.healerInCooldown()) {
        throw new SpinDispatchAdmissionError("model_cooldown", "Healer session in cooldown — try again shortly.", this.executions.healerCooldownEndAt());
      }
      throw new SpinDispatchAdmissionError("type_busy", `${request.type} session busy — try again shortly.`);
    }
    const { cardId, result } = await this.spin({
      type: request.type,
      goal: request.goal,
      title: request.title,
      priority: request.priority as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | undefined,
      source: request.source,
      deliveryMode: request.deliveryMode,
      delivery: request.delivery,
      agent: request.agent,
      timeoutMs: request.timeoutMs,
      maxToolRounds: request.maxToolRounds,
      parentCardId: request.parentCardId,
      chatId: request.chatId ? Number(request.chatId) : undefined,
      await: true,
      settlementOwner: request.settlementOwner,
      executionControl: request.executionControl,
      executionScope: request.executionScope,
      deadlineAt: request.deadlineAt,
      deliveryReady: request.deliveryReady,
    });
    return { cardId: cardId!, result: result! };
  }

  spawnChild(parentCardId: number, request: Omit<SpinRequest, "type"> & { type?: SessionType }): number {
    if (request.type === "O") throw new Error("Cannot nest orchestrators");

    // #1516: Central Worker admission authority — enforce the durable project
    // agent cap before any card, contract, attempt, or reservation is created.
    const rootCardId = resolveRootId(parentCardId) ?? parentCardId;
    const slot = checkWorkerSlotForProject(rootCardId);
    if (!slot.ok) {
      const err = new Error(`agent_cap_reached: active=${slot.active} worker_limit=${slot.workerLimit} — wait for active workers to complete before spawning more`);
      (err as Error & { code?: string }).code = "agent_cap_reached";
      throw err;
    }

    const parentProject = kanbanGetCard(parentCardId);
    if (parentProject && parentProject.max_tokens != null) {
      const workerTokens = request.contract?.limits?.max_tokens;
      if (!workerTokens || workerTokens <= 0) {
        throw new Error("Worker must declare max_tokens under a capped project");
      }
    }

    // Pre-validate contract structure before creating any state.
    if (request.contract) {
      const preCheck = normalizeContract({
        schema_version: 1,
        id: request.contract.id || "",
        goal: request.goal,
        criteria: request.contract.criteria,
        expected_artifacts: request.contract.expected_artifacts,
        verification_commands: request.contract.verification_commands,
        required_capabilities: request.contract.required_capabilities,
        supports_root_criteria: request.contract.supports_root_criteria,
        limits: request.contract.limits,
        provenance: {
          root_card_id: 0,
          card_id: 0,
          authored_by: "orc",
          created_at: new Date().toISOString(),
        },
      });
      if (!preCheck.ok) {
        throw new Error(`Contract validation failed: ${preCheck.errors.map(e => e.message).join("; ")}`);
      }
      const rootCardId = resolveRootId(parentCardId) ?? parentCardId;
      const mappingError = validateWorkerRootCriteria(
        rootCardId,
        request.contract.id || "(pending)",
        request.contract.supports_root_criteria ? [...request.contract.supports_root_criteria] : [],
      );
      if (mappingError) throw new Error(mappingError);

    }

    // Create card (kanbanEnqueue is synchronous, no spin start)
    const cardTitle = request.title ?? request.goal.slice(0, 80);
    const cardId = kanbanEnqueue(cardTitle, request.source ?? "agent", undefined, {
      priority: (request.priority ?? "MEDIUM") as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      type: "W",
      parent_id: parentCardId,
      notes: request.contract ? JSON.stringify({ supervised: true }) : undefined,
    });
    // Create contract + attempt BEFORE spin starts, so the card is never
    // visible to Reconciler/Spin without supervision data.
    if (request.contract && cardId) {
      const service = new WorkerSupervisionService();
      const rootCardId = resolveRootId(parentCardId) ?? parentCardId;
      const result = service.createChild(request.goal, cardId, rootCardId, "orc", {
        criteria: request.contract.criteria as Array<{ id: string; description: string }>,
        expectedArtifacts: request.contract.expected_artifacts as Array<{ id: string; kind: "file" | "directory" | "report" | "logical"; ref: string; required: boolean; criterion_ids: string[] }>,
        verificationCommands: request.contract.verification_commands as Array<{ id: string; argv: string[]; cwd?: string; timeout_ms: number; criterion_ids: string[] }>,
        requiredCapabilities: [...request.contract.required_capabilities],
        supportsRootCriteria: request.contract.supports_root_criteria ? [...request.contract.supports_root_criteria] : undefined,
        limits: { ...request.contract.limits },
      });
      if ("error" in result) {
        throw new Error(`Contract creation rejected: ${result.error}`);
      }
      request.attemptId = result.attemptId;
      // Reconciler is the single scheduling authority for supervised Workers.
      // kanbanEnqueue already emitted card:queued; because contract creation is
      // synchronous, the queued wake observes a fully initialized attempt.
      // Starting Spin here would race the claim and allow a Worker to execute
      // without the durable ownership transition being the source of truth.
      return cardId;
    }
    // No contract — legacy unsupervised path.
    void this.spin({
      type: "W",
      goal: request.goal,
      cardId,
      parentCardId,
      title: request.title,
      priority: request.priority as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | undefined,
      source: request.source,
      contractId: request.contract?.id,
      attemptId: request.attemptId,
      executionControl: request.executionControl,
      executionScope: request.executionScope,
      deadlineAt: request.deadlineAt,
      deliveryMode: request.deliveryMode,
      delivery: request.delivery,
      agent: request.agent,
      timeoutMs: request.timeoutMs,
      callbackPeer: request.callbackPeer,
      sourcePeer: request.sourcePeer,
      chatId: request.chatId ? Number(request.chatId) : undefined,
      settlementOwner: "spin",
      await: false,
    });
    return cardId;
  }

  // ── Internal ───────────────────────────────────────────────────────────

  // ── Internal ───────────────────────────────────────────────────────────

  /**
   * #1539: wake entry for the kanban-retry due source — unsupervised dispatch
   * without the heartbeat. Re-reads the dispatch order (future retries
   * excluded) and dispatches what is due; supervised cards are skipped.
   */
  drainQueuedCards(): void {
    this.executions.drainLegacyQueued((request) => this.dispatch(request));
  }

  /** Periodic housekeeping — registered as HB task (#980). */
  async tick(): Promise<void> {
    // #1364: drain only non-supervised cards; supervised dispatch goes through Reconciler
    this.executions.drainLegacyQueued((request) => this.dispatch(request));
    // #1540: periodic cleanup (skill trash, audit rotation, ended-session
    // pruning) is owned by the maintenance component at the existing cadence.
    this.maintenance.tick();
  }

  /** #1364: Idempotent session finalization — records endedAt, releases resources exactly once. */
  private finalizeSession(session: ManagedSession, reason: string): void {
    const metadata = session as unknown as Record<string, unknown>;
    if (session.status === "ended" && metadata["endedAt"] !== undefined) return;
    this.releaseSessionTransport(session);
    session.active = false;
    metadata["endedAt"] = Date.now();
    session.status = "ended";
    pushLog(session, `finalized: ${reason}`);
    logDebug(TAG, `Session finalized: ${session.userId} id=${session.id} reason=${reason}`);
  }

  /**
   * #1439: Complete set of card IDs Spin currently considers running, across
   * every session type. This is the single authoritative source doctor's
   * Kanban probe correlates against — publish on every lifecycle transition
   * plus once per heartbeat (see phase-heartbeat.ts) so an abrupt process
   * exit cannot leave a stale entry indefinitely "active".
   */
  getActiveCardIds(): number[] {
    return [...this.executions.runningCardIds()];
  }

  /** Current executor occupancy for a session type (used by Reconciler adapters). */
  getRunningCount(type: SessionType): number {
    return this.executions.runningCount(type);
  }
}

/**
 * #1332: Render a steering continuation prompt from a batch of instructions.
 * Non-deceptive — the model sees these as user input received while it was busy.
 */
export function renderSteeringContinuation(batch: QueuedSessionInstruction[]): string {
  const items = batch.map((i, idx) => `${idx + 1}. ${i.text}`).join("\n");
  return `[USER STEERING — received while you were working]\n${items}\n[/USER STEERING]\n\nIncorporate this direction into the current project. Do not restart completed work unnecessarily. Report the updated result.`;
}

/** #675: Fire result callback to the delegating peer. Fire-and-forget. */
async function fireCallback(peerName: string, taskId: number, status: "done" | "failed", result?: string, error?: string, artifacts?: Array<{ name: string; content: string }>, tokensUsed?: number): Promise<void> {
  try {
    const { getPeerTransport } = await import("./peer-transport/index.js");
    const transport = getPeerTransport();
    const payload: Record<string, unknown> = { action: "callback", task_id: taskId, status, result_summary: result, error, tokens_used: tokensUsed ?? 0 };
    if (artifacts?.length) payload.artifacts = artifacts;
    await transport.send(peerName, { type: "callback", payload });
    logInfo(TAG, `Callback fired to ${peerName} for card:${taskId} (${status})`);
  } catch (err) {
    logWarn(TAG, `Callback to ${peerName} failed (card:${taskId}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const spin = new Spin();
