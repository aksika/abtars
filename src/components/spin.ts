/**
 * spin.ts — Unified session router (#943, #953).
 * Single flat Map<sessionId, ManagedSession>. No bucketing. No PlatformState.
 */

import { logInfo, logWarn, logDebug } from "./logger.js";
import { logAndSwallow } from "./log-and-swallow.js";
import { kanbanEnqueue, kanbanRunning, kanbanComplete, kanbanFail, kanbanRetryOrFail, kanbanList, kanbanGetCard, isUnblocked, resolveRootId } from "./tasks/kanban-board.js";
import type { SubagentRuntime, AgentSession } from "./subagent-runtime.js";
import type { IKiroTransport, RuntimeUsageSnapshot } from "./transport/kiro-transport.js";
import { loadUsers } from "./user-registry.js";
import { getMasterUserId } from "./master-user.js";
import type { ManagedSession, SpinRequest, SessionType, SpinSessionSpec, SpinResult, StepEvent, DispatchBackgroundOptions, SpinExecutionDriver, QueuedSessionInstruction } from "./spin-types.js";
import { sessionType } from "./spin-types.js";
import { profileFor, isValidSessionType, type SessionProfile } from "./spin-profiles.js";
import { WorkerSupervisionService } from "./worker-supervision-service.js";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import * as Sessions from "./spin-sessions.js";
import { pushLog, isHollow } from "./spin-sessions.js";
import { leaseInstructions, markDelivered, markConsumed, failAfterDelivery, expireInstructions } from "./session-instruction-queue.js";
import { createExecutionTelemetryScope } from "./execution-telemetry.js";
import type { OrcActivityFeed } from "./orc-activity-feed.js";
import type { SessionOutputFeed } from "./session-output-feed.js";
import { createOutputObserver } from "./session-output-feed.js";

export type { ManagedSession, SpinRequest, SessionType } from "./spin-types.js";
export { sessionType, sessionCreatedAt, typeLabel, typeAgent, parseSessionType } from "./spin-types.js";
export { isHollow };

const TAG = "spin";

/** #1364: Returns true if a card has an active supervision contract. */
function cardHasSupervision(cardId: number): boolean {
  try {
    const store = new WorkerSupervisionStore();
    return store.contractExists(cardId) && store.hasLiveClaim(cardId);
  } catch { return false; }
}
const USER_SESSION_IDLE_MS = parseInt(process.env["USER_SESSION_IDLE_MS"] ?? "7200000", 10);
const GUEST_SESSION_IDLE_MS = parseInt(process.env["GUEST_SESSION_IDLE_MS"] ?? "1800000", 10);
const MAX_TOTAL_SESSIONS = parseInt(process.env["MAX_TOTAL_SESSIONS"] ?? "12", 10);
const SESSION_CREATE_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

const MAX_STEER_ROUNDS = 10;

const MAX_CONCURRENT: Partial<Record<SessionType, number>> = {
  T: 1, O: 1, B: 1, D: 1, H: 1, W: 3,
};

export class Spin {
  private sessions = new Map<string, ManagedSession>();
  private nextIndex = 0;
  private running = new Map<SessionType, Set<number>>();
  private runtime: SubagentRuntime | null = null;
  private memory: { recordMessage(opts: { role: string; content: string; timestamp: number; userId: string; sessionId: string }): void } | null = null;
  private orcSession: AgentSession | null = null;
  private _lastHealerDoneAt = 0;
  private _housekeepCounter = 0;
  private orcActivityFeed?: OrcActivityFeed;
  private sessionOutputFeed?: SessionOutputFeed;

  setRuntime(runtime: SubagentRuntime): void { this.runtime = runtime; }
  setMemory(memory: Spin["memory"]): void { this.memory = memory; }
  setOrcActivityFeed(feed: OrcActivityFeed): void { this.orcActivityFeed = feed; }
  setSessionOutputFeed(feed: SessionOutputFeed): void { this.sessionOutputFeed = feed; }

  // ── Session CRUD ───────────────────────────────────────────────────────

  getActiveSession(userId: string, platform: string): ManagedSession {
    let s = Sessions.getActiveSession(this.sessions, userId, platform);
    if (!s) {
      // Auto-create initial Main session
      const r = Sessions.allocateSession(this.sessions, this.nextIndex, "A", userId, platform, 0, { active: true });
      this.nextIndex = r.nextIndex;
      s = r.session;
    }
    return s;
  }

  getActiveSessionId(userId: string, platform: string): string {
    return this.getActiveSession(userId, platform).id;
  }

  createSession(userId: string, platform: string, type: SessionType): ManagedSession | string {
    // Ensure a Main session exists before creating additional ones
    this.getActiveSession(userId, platform);
    const r = Sessions.createSession(this.sessions, this.nextIndex, userId, platform, type, 0, MAX_TOTAL_SESSIONS);
    if (typeof r === "string") return r;
    this.nextIndex = r.nextIndex;
    return r.session;
  }

  createSubSession(userId: string, platform: string, type: SessionType): ManagedSession | string {
    const r = Sessions.createSubSession(this.sessions, this.nextIndex, userId, platform, type, 0, MAX_TOTAL_SESSIONS);
    if (typeof r === "string") return r;
    this.nextIndex = r.nextIndex;
    return r.session;
  }

  createHollowSession(userId: string, platform: string, type: SessionType, peer: string, remoteSessionId: string): ManagedSession | string {
    const r = Sessions.createHollowSession(this.sessions, this.nextIndex, userId, platform, type, 0, peer, remoteSessionId, MAX_TOTAL_SESSIONS);
    if (typeof r === "string") return r;
    this.nextIndex = r.nextIndex;
    return r.session;
  }

  /** Allocate a named Dreamy (D) session upfront for the duration of a sleep cycle (#1280).
   *  Non-active, platform="background" — visible in master /session (showAll) for the full cycle.
   *  Call at sleep start before the first runtime.complete(); the caller holds the returned id
   *  and passes it as sessionId to subsequent spin({ type:"D", sessionId }) calls. */
  allocateDreamySession(name: string): ManagedSession {
    const userId = getMasterUserId();
    const r = Sessions.allocateSession(this.sessions, this.nextIndex, "D", userId, "background", 0, { active: false });
    this.nextIndex = r.nextIndex;
    r.session.name = name;
    return r.session;
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
    const r = Sessions.allocateSession(this.sessions, this.nextIndex, spec.type, spec.userId, spec.platform, 0, { active: false });
    this.nextIndex = r.nextIndex;
    r.session.name = spec.name;
    r.session.workingDir = spec.workingDir;
    (r.session as unknown as Record<string, unknown>).externalMetadata = spec.metadata;
    return r.session;
  }

  /**
   * #1405 — End an external Pi generation session. Validates the immutable
   * metadata to ensure the caller owns this exact generation.
   */
  endExternalSession(sessionId: string, expected: { runId: string; generation: number }): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const meta = (session as unknown as Record<string, unknown>).externalMetadata as { runId?: string; generation?: number } | undefined;
    if (!meta || meta.runId !== expected.runId || meta.generation !== expected.generation) return false;
    const r = Sessions.endSession(this.sessions, this.nextIndex, session.userId, session.platform, session.shortIndex);
    if (typeof r === "string") return false;
    this.nextIndex = r.nextIndex;
    this.releaseSessionTransport(r.ended);
    return true;
  }

  switchSession(userId: string, platform: string, index: number): ManagedSession | string {
    return Sessions.switchSession(this.sessions, userId, platform, index);
  }

  endSession(userId: string, platform: string, index?: number): ManagedSession | string {
    const r = Sessions.endSession(this.sessions, this.nextIndex, userId, platform, index);
    if (typeof r === "string") return r;
    this.nextIndex = r.nextIndex;
    this.releaseSessionTransport(r.ended);
    return r.ended;
  }

  killSession(userId: string, platform: string, index: number): ManagedSession | string {
    const r = Sessions.killSession(this.sessions, this.nextIndex, userId, platform, index);
    if (typeof r === "string") return r;
    this.nextIndex = r.nextIndex;
    this.releaseSessionTransport(r.killed);
    return r.killed;
  }

  pauseSession(userId: string, platform: string, index?: number): ManagedSession | string {
    return Sessions.pauseSession(this.sessions, userId, platform, index);
  }

  resumeSession(userId: string, platform: string, index?: number): ManagedSession | string {
    return Sessions.resumeSession(this.sessions, userId, platform, index);
  }

  listSessions(userId: string, platform: string): { sessions: ManagedSession[]; activeIndex: number } {
    const list = Sessions.listSessions(this.sessions, userId, platform);
    const active = list.find(s => s.active);
    return { sessions: list, activeIndex: active?.shortIndex ?? 0 };
  }

  listAllSessions(): ManagedSession[] {
    return Sessions.listAllSessions(this.sessions);
  }

  getSessionById(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** #1336: Look up a session by global shortIndex across all platforms. Returns undefined if not found or ended. */
  getSessionByGlobalIndex(index: number): ManagedSession | undefined {
    for (const s of this.sessions.values()) {
      if (s.shortIndex === index && s.status !== "ended") return s;
    }
    return undefined;
  }

  /** #1319: Expose session map for snapshot builder. */
  getSessions(): Map<string, ManagedSession> {
    return this.sessions;
  }

  formatList(userId: string, platform: string, showAll = false): string {
    return Sessions.formatList(this.sessions, userId, platform, showAll);
  }

  clearAll(): void { this.sessions.clear(); this.nextIndex = 0; }

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
    let agentSession: import("./subagent-runtime.js").AgentSession;
    try {
      agentSession = await Promise.race([
        this.runtime!.session("professor", userId),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Session creation timed out")), SESSION_CREATE_TIMEOUT_MS)),
      ]);
    } catch (err) {
      this.finalizeSession(session, "transport_attach_failed");
      throw err;
    }
    session.transport = agentSession.transport!;
    session.transportOwner = "runtime";
    session.releaseTransport = () => agentSession.destroy();
    session.status = "ready";
    session.lastActiveAt = Date.now();
    const t = session.transport as any;
    session.pid = t?._rawClient?.pid ?? t?.agent?.pid ?? undefined;
    pushLog(session, "transport ready");
    logInfo(TAG, `Session ready: ${session.userId} id=${session.id}${session.pid ? ` pid=${session.pid}` : ""}`);
  }

  destroySession(userId: string, sessionId?: string): void {
    for (const s of this.sessions.values()) {
      if (s.userId !== userId) continue;
      if (sessionId && s.id !== sessionId) continue;
      if (s.idleTimeoutMs === Infinity) continue;
      this.finalizeSession(s, "destroyed");
      logInfo(TAG, `Session destroyed: ${userId} id=${s.id}`);
    }
  }

  destroyAll(): void {
    for (const s of this.sessions.values()) {
      this.releaseSessionTransport(s);
    }
    if (this.orcSession) { try { this.orcSession.destroy(); } catch (err) { logAndSwallow(TAG, "destroy", err); } this.orcSession = null; }
    this.sessions.clear();
    this.nextIndex = 0;
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
    const orcSession = [...this.sessions.values()].find(s => s.id.includes("_O_") && s.status !== "ended");
    if (!orcSession) return null;
    const { result } = await this.spin({ type: "O", sessionId: orcSession.id, prompt: `[USER] ${message}`, await: true });
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
      const found = this.sessions.get(spec.sessionId);
      if (!found) throw new Error(`Spin: sessionId ${spec.sessionId} not found`);
      if (found.status === "ended") throw new Error(`Spin: sessionId ${spec.sessionId} is ended`);
      session = found;
    } else if (spec.active || profile.resolution === "active") {
      session = this.getActiveSession(userId, platform);
    } else if (profile.resolution === "singleton") {
      session = this.getOrCreateVisibleSession(userId, spec.type)!;
    } else {
      const r = Sessions.allocateSession(this.sessions, this.nextIndex, spec.type, userId, platform, chatId);
      this.nextIndex = r.nextIndex; session = r.session;
      if (spec.metadata) session.metadata = { ...spec.metadata };
    }
    const stepIndex = (session.messageCount >> 1) + 1;

    // #1332: Assign execution generation for steering continuity
    session.activeExecutionId = `${session.id}_${stepIndex}_${Date.now()}`;

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
      });
    }
    if (cardId !== undefined && this.canDispatch(spec.type, cardId)) {
      this.markRunning(spec.type, cardId); kanbanRunning(cardId);
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
      // 4. before-hook
      await profile.beforePrompt?.(session, cardId);

      // 5. Resolve the execution transport. Reuse the session's OWN transport if it
      //    already has one (A per-user main turn, D step N, O reuse). Only
      //    create+attach for a NEW persistent session.
      let sessionTransport = session.transport as IKiroTransport | undefined;
      if (persistent && !sessionTransport) {
        const agentSession = await this.runtime.session(agent, profile.resolution === "active" ? userId : undefined);
        sessionTransport = agentSession.transport as IKiroTransport;
        session.transport = sessionTransport;
        session.transportOwner = "runtime";
        session.releaseTransport = () => agentSession.destroy();
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
          const contract = sup.getContractForCard(cardId);
          if (contract) {
            prompt = sup.renderContractForPrompt(contract) + "\n\n" + prompt;
          }
        } catch { /* best effort — non-supervised cards pass through unchanged */ }
      }
      pushLog(session, `spin type=${spec.type} agent=${agent} step=${stepIndex}`);

      // 7. Execute — persistent/continuation sends via the session's own transport
      //    (key = session.id preserves the Orc sneak-in); oneshot uses runtime.complete.
      //    #1329: thread the just-persisted raw user message ID through as the
      //    beforeMessageId cursor so DirectApiTransport can bound its DB-backed
      //    context assembly to history only.
      //    #1332: wrap with steering continuation loop for persistent sessions.
      const promptContext: import("./transport/kiro-transport.js").PromptRequestContext = {
        userId: spec.userId ?? userId,
        beforeMessageId: spec.currentMessageId,
        directContextTurn: spec.directContextTurn,
        executionTelemetry,
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
        if (!this.sessionOutputFeed || !session.activeExecutionId) {
          return await transport.sendPrompt(key, msg, image, ctx);
        }
        const obs = createOutputObserver(this.sessionOutputFeed, {
          sessionId: session.id,
          executionId: session.activeExecutionId,
        });
        const enriched = { ...(ctx ?? {}), outputObserver: obs };
        let result: string;
        try {
          result = await transport.sendPrompt(key, msg, image, enriched);
          obs.end("complete");
        } catch (err) {
          obs.end("error");
          throw err;
        } finally {
          obs.invalidate();
        }
        return result;
      };
      // #1361: Resolve a continuation-capable execution driver for this session.
      // Persistent sessions wrap the existing session transport; one-shot sessions
      // open a fresh RuntimeExecution handle keyed by session.id.
      const resolveDriver = async (): Promise<SpinExecutionDriver> => {
        if (sessionTransport) {
          return {
            send: (msg, img, ctx) => observe(sessionTransport!, session.id, msg, img, ctx),
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
        return {
          send: async (msg, img, ctx) => {
            if (!this.sessionOutputFeed || !session.activeExecutionId) {
              return (await executor.send(msg, img, ctx)) || "(no output)";
            }
            const obs = createOutputObserver(this.sessionOutputFeed, {
              sessionId: session.id, executionId: session.activeExecutionId,
            });
            const enriched = { ...(ctx ?? {}), outputObserver: obs };
            try {
              const r = (await executor.send(msg, img, enriched)) || "(no output)";
              obs.end("complete");
              return r;
            } catch (err) {
              obs.end("error");
              throw err;
            } finally {
              obs.invalidate();
            }
          },
          close: async () => {
            await executor.close();
            sessionTransport = undefined;
          },
          ephemeral: true,
        };
      };
      const executeWithSteering = async (): Promise<string> => {
        const driver = await resolveDriver();
        session.steeringAccepting = true;
        try {
          let result = (await driver.send(prompt, spec.imageContent as { mime: string; base64: string } | undefined, promptContext)) || "(no output)";
          for (let round = 0; round < MAX_STEER_ROUNDS; round++) {
            const batch = leaseInstructions(session);
            if (!batch) { session.steeringAccepting = false; break; }
            markDelivered(batch);
            try {
              result = (await driver.send(renderSteeringContinuation(batch.instructions as QueuedSessionInstruction[]), undefined, { userId: spec.userId ?? userId, executionTelemetry })) || "(no output)";
              markConsumed(batch, session);
            } catch (steerErr) {
              failAfterDelivery(batch, session, "steer_failed");
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
          this.finishSpin(spec, profile, session, cardId, stepIndex, started, r, terminate, telemetryUsage);
        }).catch(e => {
          executionTelemetry.close();
          this.failSpin(spec, profile, session, cardId, stepIndex, started, e, terminate);
        });
        return { sessionId: session.id, cardId };
      }
      const result = await executeWithSteering();
      const telemetryUsage = executionTelemetry.snapshot();
      executionTelemetry.close();
      await this.finishSpin(spec, profile, session, cardId, stepIndex, started, result, terminate, telemetryUsage);
      return { sessionId: session.id, cardId, result };
    } catch (err) {
      executionTelemetry.close();
      // Covers: pre-exec throws (steps 4-6) AND awaited execution failures (step 7).
      // failSpin calls markDone + drainQueued — concurrency slot always released.
      await this.failSpin(spec, profile, session, cardId, stepIndex, started, err, terminate);
      if (spec.await) throw err;                    // awaited callers still see the error
      return { sessionId: session.id, cardId };     // fire-and-forget: recorded, no unhandled rejection
    }
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
        this.markDone(spec.type, cardId);
        return;
      }

      let artifacts: Array<{ name: string; content: string }> = [];
      try {
        const { drainArtifacts } = require("./transport/artifact-tools.js") as typeof import("./transport/artifact-tools.js");
        artifacts = drainArtifacts(cardId) ?? [];
      } catch { /* artifact-tools unavailable (e.g. test env) — skip */ }
      // #1366: Collect evidence and settle for supervised Workers
      let workerSummary = result.slice(0, 500);
      if (spec.contractId || spec.type === "W") {
        try {
          const svc = new WorkerSupervisionService();
          const outcome = svc.collectAndSettle(cardId, result, session.workingDir);
          if (outcome.settled) workerSummary = outcome.summary;
        } catch { /* non-supervised Workers pass through unchanged */ }
      }
      kanbanComplete(cardId, null, workerSummary);
      if (spec.callbackPeer) {
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
    const stepEvent: StepEvent = {
      sessionId: session.id, cardId, stepIndex, result,
      durationMs: Date.now() - started,
      inputTokens: usage?.input, outputTokens: usage?.output,
    };
    await spec.onStepComplete?.(stepEvent);

    this.applyTerminate(session, terminate);
    if (cardId !== undefined) { this.markDone(spec.type, cardId); this.drainQueued(); }
  }

  private async failSpin(
    spec: SpinSessionSpec, profile: SessionProfile, session: ManagedSession,
    cardId: number | undefined, stepIndex: number, started: number, err: unknown,
    terminate: "call" | "response" | "external",
  ): Promise<void> {
    // #1332: Expire remaining queued instructions when execution fails
    if (session.instructionQueue.length > 0) expireInstructions(session, "execution_failed");

    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    logWarn(TAG, `${spec.type} spin failed: ${msg}`);
    pushLog(session, `failed: ${msg.slice(0, 80)}`);
    if (cardId !== undefined) {
      // #1248: If terminal already won (cancellation), skip fail settlement
      if (spec.executionControl?.terminal) {
        logInfo(TAG, `Card ${cardId}: execution control already terminal — skipping failSpin settlement`);
        this.markDone(spec.type, cardId);
        return;
      }
      kanbanRetryOrFail(cardId, msg);
      if (spec.callbackPeer) fireCallback(spec.callbackPeer, cardId, "failed", undefined, msg);
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
    const stepEvent: StepEvent = {
      sessionId: session.id, cardId, stepIndex,
      error: err instanceof Error ? err : new Error(msg),
      durationMs: Date.now() - started,
    };
    await spec.onStepComplete?.(stepEvent);

    this.applyTerminate(session, terminate);
    if (cardId !== undefined) { this.markDone(spec.type, cardId); this.drainQueued(); }
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
    if (terminate === "call") { this.finalizeSession(session, "call_terminated"); this.sessions.delete(session.id); }
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
      for (const s of this.sessions.values()) {
        if (s.id.includes("_O_") && s.status !== "ended") return s;
      }
    }
    const sub = this.createSubSession(userId, "telegram", type);
    return typeof sub === "string" ? undefined : sub;
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
    const aliveSessions = [...this.sessions.values()].filter(s => s.status !== "ended").length;
    if (aliveSessions >= MAX_TOTAL_SESSIONS || !this.canDispatch(request.type, cardId)) {
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
    const aliveSessions = [...this.sessions.values()].filter(s => s.status !== "ended").length;
    if (aliveSessions >= MAX_TOTAL_SESSIONS) {
      throw new Error("System busy — max sessions reached.");
    }
    if (!this.canDispatch(request.type, 0)) {
      throw new Error(`${request.type} session busy or in cooldown — skipping`);
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
    });
    return { cardId: cardId!, result: result! };
  }

  spawnChild(parentCardId: number, request: Omit<SpinRequest, "type"> & { type?: SessionType }): number {
    if (request.type === "O") throw new Error("Cannot nest orchestrators");
    const cardId = this.dispatch({ ...request, type: "W", parentCardId }).cardId;
    if (request.contract && cardId) {
      try {
        const service = new WorkerSupervisionService();
        const rootCardId = resolveRootId(parentCardId) ?? parentCardId;
        service.createChild(request.goal, cardId, rootCardId, "orc", {
          criteria: request.contract.criteria as Array<{ id: string; description: string }>,
          expectedArtifacts: request.contract.expected_artifacts as Array<{ id: string; kind: "file" | "directory" | "report" | "logical"; ref: string; required: boolean; criterion_ids: string[] }>,
          verificationCommands: request.contract.verification_commands as Array<{ id: string; argv: string[]; cwd?: string; timeout_ms: number; criterion_ids: string[] }>,
          requiredCapabilities: [...request.contract.required_capabilities],
          supportsRootCriteria: request.contract.supports_root_criteria ? [...request.contract.supports_root_criteria] : undefined,
          limits: { ...request.contract.limits },
        });
      } catch (err) {
        logWarn(TAG, `spawnChild: failed to create contract for card ${cardId}: ${err}`);
      }
    }
    return cardId;
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private drainQueued(): void {
    const queued = kanbanList("queued");
    const now = new Date().toISOString();
    for (const card of queued) {
      // #1364: Supervised cards go through Reconciler — skip them here
      if (cardHasSupervision(card.id)) continue;
      // #897: respect retry backoff
      if ((card as any).next_retry_at && (card as any).next_retry_at > now) continue;
      // #677: respect DAG dependencies
      if (!isUnblocked(card)) continue;
      // #1327: validate card.type is a real SessionType BEFORE dispatching.
      // Without this, an unknown type (e.g. ticket category "bug") reaches
      // spin() and crashes the bridge on profile.agent access. Fail the card
      // with a clear note instead — Layer A in spin() is the second line of
      // defense if this ever regresses.
      const type = card.type as string;
      if (!isValidSessionType(type)) {
        const note = `invalid type for Spin dispatch: "${type}" is not a SessionType (#1327)`;
        logWarn(TAG, `drainQueued: card ${card.id} has invalid type "${type}" — failing (Layer B)`);
        kanbanFail(card.id, note);
        continue;
      }
      if (this.canDispatch(type, card.id)) {
        const goal = (card as any).goal || card.title;
        this.dispatch({ type, goal, source: (card.source as SpinRequest["source"]) ?? "task", cardId: card.id });
      }
    }
  }

  /** Periodic housekeeping — registered as HB task (#980). */
  async tick(): Promise<void> {
    // #1364: drain only non-supervised cards; supervised dispatch goes through Reconciler
    this.drainQueued();
    // #1248: Legacy stale scanner removed — execution timeout is the real bound
    this._housekeepCounter++;
    if (this._housekeepCounter % 72 === 0) {
      this.pruneSkillTrash();
      this.rotateAuditLog();
      this.pruneEndedSessions();
    }
  }

  /** #613: Prune .trash/ entries older than 7 days (~hourly). */
  private pruneSkillTrash(): void {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const { existsSync, readdirSync, rmSync, statSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const { abtarsHome } = require("../paths.js") as typeof import("../paths.js");
    const trashPath = join(abtarsHome(), "skills", ".trash");
    if (!existsSync(trashPath)) return;
    const now = Date.now();
    for (const entry of readdirSync(trashPath)) {
      try {
        const full = join(trashPath, entry);
        const stat = statSync(full);
        if (now - stat.mtimeMs > SEVEN_DAYS_MS) {
          rmSync(full, { recursive: true });
          logInfo("skill-trash-prune", `Pruned: ${entry}`);
        }
      } catch (err) { logAndSwallow(TAG, "prune entry", err); }
    }
  }

  /** #681: Rotate audit.jsonl when > 10MB, prune files older than 30 days (~hourly). */
  private rotateAuditLog(): void {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const { existsSync, statSync, renameSync, readdirSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const { abtarsHome } = require("../paths.js") as typeof import("../paths.js");
    const logsDir = join(abtarsHome(), "logs");
    const auditPath = join(logsDir, "audit.jsonl");
    if (!existsSync(auditPath)) return;
    try {
      const stat = statSync(auditPath);
      if (stat.size > 10 * 1024 * 1024) {
        const date = new Date().toISOString().slice(0, 10);
        renameSync(auditPath, join(logsDir, `audit-${date}.jsonl`));
        logInfo("audit-rotation", `Rotated audit.jsonl (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
      }
    } catch (err) { logAndSwallow(TAG, "audit rotate", err); }
    const now = Date.now();
    try {
      for (const f of readdirSync(logsDir)) {
        if (!f.startsWith("audit-") || !f.endsWith(".jsonl")) continue;
        const full = join(logsDir, f);
        const stat = statSync(full);
        if (now - stat.mtimeMs > THIRTY_DAYS_MS) {
          unlinkSync(full);
          logInfo("audit-rotation", `Pruned: ${f}`);
        }
      }
    } catch (err) { logAndSwallow(TAG, "audit prune", err); }
  }

  /** #1364: Idempotent session finalization — records endedAt, releases resources exactly once. */
  private finalizeSession(session: ManagedSession, reason: string): void {
    if (session.status === "ended") return; // already finalized
    this.releaseSessionTransport(session);
    session.active = false;
    (session as unknown as Record<string, unknown>)["endedAt"] = Date.now();
    session.status = "ended";
    pushLog(session, `finalized: ${reason}`);
    logDebug(TAG, `Session finalized: ${session.userId} id=${session.id} reason=${reason}`);
  }

  /** #1248: Prune ended sessions older than 1 hour (~hourly). Prevents unbounded Map growth. */
  private pruneEndedSessions(): void {
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      const endedAt = ((s as unknown as Record<string, unknown>)["endedAt"] as number | undefined) ?? s.lastActiveAt;
      if (s.status === "ended" && now - endedAt > ONE_HOUR_MS) {
        this.sessions.delete(id);
        logDebug(TAG, `Pruned ended session: ${s.userId} id=${id}`);
      }
    }
  }

  private canDispatch(type: SessionType, _cardId: number): boolean {
    const max = MAX_CONCURRENT[type] ?? 5;
    if ((this.running.get(type)?.size ?? 0) >= max) return false;
    // #987: 2-min cooldown after H session ends
    if (type === "H" && Date.now() - this._lastHealerDoneAt < 120_000) return false;
    return true;
  }

  private markRunning(type: SessionType, cardId: number): void {
    if (!this.running.has(type)) this.running.set(type, new Set());
    this.running.get(type)!.add(cardId);
  }

  private markDone(type: SessionType, cardId: number): void {
    this.running.get(type)?.delete(cardId);
    if (type === "H") this._lastHealerDoneAt = Date.now();
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
