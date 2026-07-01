/**
 * spin.ts — Unified session router (#943, #953).
 * Single flat Map<sessionId, ManagedSession>. No bucketing. No PlatformState.
 */

import { logInfo, logWarn, logDebug } from "./logger.js";
import { logAndSwallow } from "./log-and-swallow.js";
import { kanbanEnqueue, kanbanRunning, kanbanComplete, kanbanFail, kanbanRetryOrFail, kanbanList, kanbanGetCard, isUnblocked } from "./tasks/kanban-board.js";
import type { SubagentRuntime, AgentSession } from "./subagent-runtime.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import { loadUsers } from "./user-registry.js";
import { getMasterUserId } from "./master-user.js";
import type { ManagedSession, SpinRequest, SessionType, SpinSessionSpec, SpinResult, StepEvent, DispatchBackgroundOptions } from "./spin-types.js";
import { sessionType } from "./spin-types.js";
import { profileFor, type SessionProfile } from "./spin-profiles.js";
import * as Sessions from "./spin-sessions.js";
import { pushLog, isHollow } from "./spin-sessions.js";

export type { ManagedSession, SpinRequest, SessionType } from "./spin-types.js";
export { sessionType, sessionCreatedAt, typeLabel, typeAgent, parseSessionType } from "./spin-types.js";
export { isHollow };

const TAG = "spin";
const USER_SESSION_IDLE_MS = parseInt(process.env["USER_SESSION_IDLE_MS"] ?? "7200000", 10);
const GUEST_SESSION_IDLE_MS = parseInt(process.env["GUEST_SESSION_IDLE_MS"] ?? "1800000", 10);
const MAX_TOTAL_SESSIONS = parseInt(process.env["MAX_TOTAL_SESSIONS"] ?? "12", 10);
const SESSION_CREATE_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

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

  setRuntime(runtime: SubagentRuntime): void { this.runtime = runtime; }
  setMemory(memory: Spin["memory"]): void { this.memory = memory; }

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

  switchSession(userId: string, platform: string, index: number): ManagedSession | string {
    return Sessions.switchSession(this.sessions, userId, platform, index);
  }

  endSession(userId: string, platform: string, index?: number): ManagedSession | string {
    const r = Sessions.endSession(this.sessions, this.nextIndex, userId, platform, index);
    if (typeof r === "string") return r;
    this.nextIndex = r.nextIndex;
    return r.ended;
  }

  killSession(userId: string, platform: string, index: number): ManagedSession | string {
    const r = Sessions.killSession(this.sessions, this.nextIndex, userId, platform, index);
    if (typeof r === "string") return r;
    this.nextIndex = r.nextIndex;
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

    if (session.transport) {
      session.lastActiveAt = Date.now();
      return session;
    }
    if (session.status === "ended") throw new Error("Session ended — use /session new");

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
      const agentSession = await Promise.race([
        this.runtime!.session("professor", userId),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Session creation timed out")), SESSION_CREATE_TIMEOUT_MS)),
      ]);
      session.transport = agentSession.transport!;
      session.status = "ready";
      session.lastActiveAt = Date.now();
      const t = session.transport as any;
      session.pid = t?._rawClient?.pid ?? t?.agent?.pid ?? undefined;
      pushLog(session, "transport ready");
      logInfo(TAG, `Session ready: ${userId} id=${session.id}${session.pid ? ` pid=${session.pid}` : ""}`);
      return session;
    } catch (err) {
      session.status = "ended";
      pushLog(session, `error: ${err instanceof Error ? err.message : String(err)}`);
      logWarn(TAG, `Session creation failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  destroySession(userId: string, sessionId?: string): void {
    for (const s of this.sessions.values()) {
      if (s.userId !== userId) continue;
      if (sessionId && s.id !== sessionId) continue;
      if (s.idleTimeoutMs === Infinity) continue;
      if (s.transport) { try { s.transport.destroy(); } catch (err) { logAndSwallow(TAG, "destroy", err); } s.transport = undefined; }
      s.status = "ended";
      s.active = false;
      pushLog(s, "destroyed");
      logInfo(TAG, `Session destroyed: ${userId} id=${s.id}`);
    }
  }

  destroyAll(): void {
    for (const s of this.sessions.values()) {
      if (s.transport) { try { s.transport.destroy(); } catch (err) { logAndSwallow(TAG, "destroy", err); } }
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

    // 3. Kanban card (user-facing work only)
    let cardId = spec.cardId;
    if (cardId === undefined && spec.goal !== undefined) {
      cardId = kanbanEnqueue(spec.title ?? spec.goal.slice(0, 80), spec.source ?? "user", undefined, {
        priority: spec.priority ?? "MEDIUM", type: spec.type, parent_id: spec.parentCardId,
        deliveryMode: spec.deliveryMode, chatId: chatId ? String(chatId) : undefined,
        notes: spec.callbackPeer ? JSON.stringify({ callback_peer: spec.callbackPeer }) : undefined,
        sourcePeer: spec.sourcePeer,
      });
    }
    if (cardId !== undefined && this.canDispatch(spec.type, cardId)) {
      this.markRunning(spec.type, cardId); kanbanRunning(cardId);
    }

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
      session.status = "ready";
    }

    // 6. Build prompt via decorators
    let prompt = spec.prompt ?? spec.goal ?? "";
    for (const decorate of profile.decorators) {
      prompt = await decorate(prompt, { session, cardId, parentCardId: spec.parentCardId });
    }
    pushLog(session, `spin type=${spec.type} agent=${agent} step=${stepIndex}`);

    // 7. Execute — persistent/continuation sends via the session's own transport
    //    (key = session.id preserves the Orc sneak-in); oneshot uses runtime.complete.
    const started = Date.now();
    const exec = sessionTransport
      ? sessionTransport.sendPrompt(session.id, prompt, spec.imageContent as { mime: string; base64: string } | undefined, spec.userId ?? userId)
      : this.runtime.complete(agent, prompt, { timeoutMs, session: "fresh" });

    if (!spec.await) {
      exec.then(r => this.finishSpin(spec, profile, session, cardId, stepIndex, started, r || "(no output)", terminate))
          .catch(e => this.failSpin(spec, profile, session, cardId, stepIndex, started, e, terminate));
      return { sessionId: session.id, cardId };
    }
    try {
      const result = (await exec) || "(no output)";
      await this.finishSpin(spec, profile, session, cardId, stepIndex, started, result, terminate);
      return { sessionId: session.id, cardId, result };
    } catch (err) {
      await this.failSpin(spec, profile, session, cardId, stepIndex, started, err, terminate);
      throw err;
    }
  }

  private async finishSpin(
    spec: SpinSessionSpec, profile: SessionProfile, session: ManagedSession,
    cardId: number | undefined, stepIndex: number, started: number, result: string,
    terminate: "call" | "response" | "external",
  ): Promise<void> {
    // Persistent sends go through session.transport (runtime.lastUsage is only
    // updated by runtime.complete). Prefer the transport's own usage; fall back
    // to runtime for oneshot.
    const usage = (session.transport as { lastUsage?: () => { input: number; output: number } | null } | undefined)?.lastUsage?.()
      ?? this.runtime?.lastUsage ?? null;
    session.messageCount += 2;
    session.lastActiveAt = Date.now();
    session.tokenCount = usage ? usage.input + usage.output : session.tokenCount;
    pushLog(session, "complete");

    if (this.memory) {
      const sid = cardId !== undefined ? `${spec.type}_card${cardId}` : `${spec.type}_${session.id}`;
      this.memory.recordMessage({ role: "user", content: spec.goal ?? spec.prompt ?? "", timestamp: Date.now(), userId: "system", sessionId: sid });
      this.memory.recordMessage({ role: "assistant", content: result, timestamp: Date.now(), userId: "system", sessionId: sid });
    }
    if (cardId !== undefined) {
      // drainArtifacts lives in transport/artifact-tools — wrapped in try/catch
      // for test envs where the module's transitive deps (artifact-store) may not
      // resolve. In production this always succeeds.
      let artifacts: Array<{ name: string; content: string }> = [];
      try {
        const { drainArtifacts } = require("./transport/artifact-tools.js") as typeof import("./transport/artifact-tools.js");
        artifacts = drainArtifacts(cardId) ?? [];
      } catch { /* artifact-tools unavailable (e.g. test env) — skip */ }
      kanbanComplete(cardId, null, result.slice(0, 500));
      if (spec.callbackPeer) {
        const card = kanbanGetCard(cardId);
        fireCallback(spec.callbackPeer, cardId, "done", result.slice(0, 500), undefined, artifacts, card?.tokens_used ?? 0);
      }
    }

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
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    logWarn(TAG, `${spec.type} spin failed: ${msg}`);
    pushLog(session, `failed: ${msg.slice(0, 80)}`);
    if (cardId !== undefined) {
      kanbanRetryOrFail(cardId, msg);
      if (spec.callbackPeer) fireCallback(spec.callbackPeer, cardId, "failed", undefined, msg);
    }
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

  private applyTerminate(session: ManagedSession, terminate: "call" | "response" | "external"): void {
    if (terminate === "call") this.sessions.delete(session.id);
    else if (terminate === "response") { session.status = "ended"; session.active = false; }
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
      parent_id: request.parentCardId, deliveryMode: request.deliveryMode,
      notes: request.callbackPeer ? JSON.stringify({ callback_peer: request.callbackPeer }) : undefined,
      chatId: request.chatId, sourcePeer: request.sourcePeer,
    });

    // Concurrency gate: blocked cards stay queued for drainQueued() to pick up.
    if (!this.canDispatch(request.type, cardId)) {
      logInfo(TAG, `${request.type} card:${cardId} queued (concurrency gate)`);
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
      agent: request.agent,
      timeoutMs: request.timeoutMs,
      callbackPeer: request.callbackPeer,
      sourcePeer: request.sourcePeer,
      chatId: request.chatId ? Number(request.chatId) : undefined,
      await: false,
    });
    return { cardId };
  }

  /**
   * @deprecated Use `spin({ type, goal, …, await: true })` instead.
   * Backward-compat wrapper: synchronously dispatches and returns the result.
   */
  async dispatchAwait(request: SpinRequest): Promise<{ cardId: number; result: string }> {
    // #987: enforce concurrency + cooldown gates
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
      agent: request.agent,
      timeoutMs: request.timeoutMs,
      parentCardId: request.parentCardId,
      chatId: request.chatId ? Number(request.chatId) : undefined,
      await: true,
    });
    return { cardId: cardId!, result: result! };
  }

  spawnChild(parentCardId: number, request: Omit<SpinRequest, "type"> & { type?: SessionType }): number {
    if (request.type === "O") throw new Error("Cannot nest orchestrators");
    return this.dispatch({ ...request, type: "W", parentCardId }).cardId;
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private drainQueued(): void {
    const queued = kanbanList("queued");
    const now = new Date().toISOString();
    for (const card of queued) {
      // #897: respect retry backoff
      if ((card as any).next_retry_at && (card as any).next_retry_at > now) continue;
      // #677: respect DAG dependencies
      if (!isUnblocked(card)) continue;
      const type = (card.type as SessionType) ?? "T";
      if (this.canDispatch(type, card.id)) {
        this.dispatch({ type, goal: card.title, source: (card.source as SpinRequest["source"]) ?? "task", cardId: card.id });
      }
    }
  }

  /** Periodic housekeeping — registered as HB task (#980). */
  async tick(): Promise<void> {
    this.drainQueued();
    this.checkStaleWorkers();
    await this.pollRemoteCards();
    this._housekeepCounter++;
    if (this._housekeepCounter % 72 === 0) {
      this.pruneSkillTrash();
      this.rotateAuditLog();
      this.pruneEndedSessions();
    }
  }

  private checkStaleWorkers(): void {
    const STALE_MS = parseInt(process.env["WORKER_STALE_MS"] || "300000", 10);
    const now = Date.now();
    for (const [, cardIds] of this.running) {
      for (const cardId of cardIds) {
        const card = kanbanGetCard(cardId);
        if (!card || card.status !== "running") continue;
        const lastActivity = new Date(card.updated_at + "Z").getTime();
        if (now - lastActivity > STALE_MS) {
          logWarn(TAG, `Stale card ${cardId} (${Math.round((now - lastActivity) / 1000)}s no activity) — failing`);
          kanbanFail(cardId, "stale — no activity");
        }
      }
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

  /** #1248: Prune ended sessions older than 1 hour (~hourly). Prevents unbounded Map growth. */
  private pruneEndedSessions(): void {
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.status === "ended" && now - s.lastActiveAt > ONE_HOUR_MS) {
        this.sessions.delete(id);
        logDebug(TAG, `Pruned ended session: ${s.userId} id=${id}`);
      }
    }
  }

  private async pollRemoteCards(): Promise<void> {
    const remoteCards = kanbanList("running", "status").filter(c => c.type === "remote");
    if (remoteCards.length === 0) return;
    const { getPeerTransport } = await import("./peer-transport/index.js");
    const transport = getPeerTransport();
    const REMOTE_MAX_AGE_MS = 15 * 60 * 1000;
    for (const card of remoteCards) {
      try {
        const meta = JSON.parse(card.notes ?? "{}") as { peer?: string; remote_task_id?: number };
        if (!meta.peer || !meta.remote_task_id) continue;
        const cardAge = Date.now() - new Date(card.created_at + "Z").getTime();
        if (cardAge > REMOTE_MAX_AGE_MS) {
          kanbanFail(card.id, `remote task timeout (${Math.round(cardAge / 60000)}min)`);
          continue;
        }
        const result = await transport.checkTask(meta.peer, meta.remote_task_id);
        if (result.status === "done") kanbanComplete(card.id, null, result.result?.slice(0, 500) ?? "completed");
        else if (result.status === "failed") kanbanFail(card.id, result.error ?? "remote task failed");
      } catch (err) { logAndSwallow(TAG, "pollRemote", err); }
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

/** #675: Fire result callback to the delegating peer. Fire-and-forget. */
async function fireCallback(peerName: string, taskId: number, status: "done" | "failed", result?: string, error?: string, artifacts?: Array<{ name: string; content: string }>, tokensUsed?: number): Promise<void> {
  try {
    const { getPeerTransport } = await import("./peer-transport/index.js");
    const transport = getPeerTransport();
    const payload: Record<string, unknown> = { action: "callback", task_id: taskId, status, result_summary: result, error, tokens_used: tokensUsed ?? 0 };
    if (artifacts?.length) payload.artifacts = artifacts;
    await transport.send(peerName, { type: "task", payload });
    logInfo(TAG, `Callback fired to ${peerName} for card:${taskId} (${status})`);
  } catch (err) {
    logWarn(TAG, `Callback to ${peerName} failed (card:${taskId}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const spin = new Spin();
