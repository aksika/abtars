/**
 * spin.ts — Unified session router (#943).
 * Single gateway for ALL sessions: interactive (A) and background (T/B/C/O/W/D/H).
 * Owns the sessions map, transport creation, routing, dispatch, lifecycle.
 * Replaces SessionManager + system-message.ts + phase-startup-notification.ts.
 */

import { logInfo, logWarn, logTrace } from "./logger.js";
import { kanbanEnqueue, kanbanRunning, kanbanComplete, kanbanFail, kanbanList, kanbanAddTokens } from "./tasks/kanban-board.js";
import type { SubagentRuntime, AgentSession } from "./subagent-runtime.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import { loadUsers } from "./user-registry.js";
import type { ManagedSession, SpinRequest, SessionType } from "./spin-types.js";
import { sessionType, typeAgent, typeLabel } from "./spin-types.js";
import type { PlatformState } from "./spin-sessions.js";
import * as Sessions from "./spin-sessions.js";
import { pushLog } from "./spin-sessions.js";

// Re-export types for consumers
export type { ManagedSession, SpinRequest, SessionType } from "./spin-types.js";
export { sessionType, sessionCreatedAt, typeLabel, typeAgent, parseSessionType } from "./spin-types.js";

const TAG = "spin";
const ORC_IDLE_MS = (parseInt(process.env["ORC_IDLE_TIMEOUT_SEC"] ?? "1200", 10)) * 1000;
const USER_SESSION_IDLE_MS = parseInt(process.env["USER_SESSION_IDLE_MS"] ?? "7200000", 10);
const GUEST_SESSION_IDLE_MS = parseInt(process.env["GUEST_SESSION_IDLE_MS"] ?? "1800000", 10);
const MAX_TOTAL_SESSIONS = parseInt(process.env["MAX_TOTAL_SESSIONS"] ?? "12", 10);
const SESSION_CREATE_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

const MAX_CONCURRENT: Partial<Record<SessionType, number>> = {
  T: 1, O: 1, B: 1, D: 1, H: 1, W: 3,
};

export class Spin {
  private readonly states = new Map<string, PlatformState>();
  private running = new Map<SessionType, Set<number>>();
  private runtime: SubagentRuntime | null = null;

  // Persistent Orc
  private orcSession: AgentSession | null = null;
  private orcIdleTimer: ReturnType<typeof setTimeout> | null = null;

  setRuntime(runtime: SubagentRuntime): void { this.runtime = runtime; }

  // ── Session CRUD (thin wrappers over spin-sessions.ts) ─────────────────

  getActiveSession(userId: string, platform: string): ManagedSession {
    return Sessions.getActiveSession(this.states, userId, platform);
  }

  getActiveSessionId(userId: string, platform: string): string {
    return Sessions.getActiveSessionId(this.states, userId, platform);
  }

  createSession(userId: string, platform: string, type: SessionType): ManagedSession | string {
    return Sessions.createSession(this.states, userId, platform, type, MAX_TOTAL_SESSIONS);
  }

  createSubSession(userId: string, platform: string, type: SessionType): ManagedSession | string {
    return Sessions.createSubSession(this.states, userId, platform, type, MAX_TOTAL_SESSIONS);
  }

  switchSession(userId: string, platform: string, index: number): ManagedSession | string {
    return Sessions.switchSession(this.states, userId, platform, index);
  }

  endSession(userId: string, platform: string, index?: number): ManagedSession | string {
    return Sessions.endSession(this.states, userId, platform, index);
  }

  killSession(userId: string, platform: string, index: number): ManagedSession | string {
    return Sessions.killSession(this.states, userId, platform, index);
  }

  pauseSession(userId: string, platform: string, index?: number): ManagedSession | string {
    return Sessions.pauseSession(this.states, userId, platform, index);
  }

  resumeSession(userId: string, platform: string, index?: number): ManagedSession | string {
    return Sessions.resumeSession(this.states, userId, platform, index);
  }

  listSessions(userId: string, platform: string): { sessions: ManagedSession[]; activeIndex: number } {
    return Sessions.listSessions(this.states, userId, platform);
  }

  listAllSessions(): ManagedSession[] {
    return Sessions.listAllSessions(this.states);
  }

  getSessionById(sessionId: string): ManagedSession | undefined {
    return Sessions.getSessionById(this.states, sessionId);
  }

  formatList(userId: string, platform: string): string {
    return Sessions.formatList(this.states, userId, platform);
  }

  clearAll(): void { this.states.clear(); }

  // ── Interactive session lifecycle (#936) ────────────────────────────────

  registerMasterSession(opts: { userId: string; chatId: number; platform: string; transport: IKiroTransport }): void {
    const session = this.getActiveSession(opts.userId, opts.platform);
    session.transport = opts.transport;
    session.delivery = "streaming";
    session.idleTimeoutMs = Infinity;
    session.chatId = opts.chatId;
    session.userId = opts.userId;
    session.platform = opts.platform;
    session.status = "ready";
    session.lastActiveAt = Date.now();
    const t = opts.transport as any;
    session.pid = t?._rawClient?.pid ?? t?.agent?.pid ?? undefined;
    pushLog(session, "master transport attached");
    logInfo(TAG, `Master session registered: ${opts.userId} (${opts.platform}:${opts.chatId}${session.pid ? ` pid=${session.pid}` : ""})`);
  }

  async resolveSession(userId: string, platform: string, chatId: number): Promise<ManagedSession> {
    const session = this.getActiveSession(userId, platform);

    if (session.transport) {
      session.lastActiveAt = Date.now();
      return session;
    }
    if (session.status === "ended") throw new Error("Session ended — use /session new");

    // Check global cap
    const total = this.listAllSessions().filter(s => s.transport).length;
    if (total >= MAX_TOTAL_SESSIONS) throw new Error("System busy, try again in a few minutes.");

    session.status = "creating";
    session.chatId = chatId;
    session.userId = userId;
    session.platform = platform;
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
      session.agentSession = agentSession;
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
    const sessions = this.listAllSessions();
    for (const s of sessions) {
      if (s.userId !== userId) continue;
      if (sessionId && s.id !== sessionId) continue;
      if (s.idleTimeoutMs === Infinity) continue; // never kill master primary
      if (s.transport) {
        try { s.transport.destroy(); } catch {}
        s.transport = undefined;
      }
      if (s.agentSession) {
        try { s.agentSession.destroy(); } catch {}
        s.agentSession = undefined;
      }
      s.status = "ended";
      pushLog(s, "destroyed");
      logInfo(TAG, `Session destroyed: ${userId} id=${s.id}`);
    }
  }

  /** Destroy all sessions (bridge shutdown). */
  destroyAll(): void {
    for (const s of this.listAllSessions()) {
      if (s.transport) { try { s.transport.destroy(); } catch {} }
      if (s.agentSession) { try { s.agentSession.destroy(); } catch {} }
    }
    if (this.orcSession) { try { this.orcSession.destroy(); } catch {} this.orcSession = null; }
    if (this.orcIdleTimer) { clearTimeout(this.orcIdleTimer); this.orcIdleTimer = null; }
    this.states.clear();
    logInfo(TAG, "All sessions destroyed (shutdown)");
  }

  // ── inject() — unified prompt injection (#943) ─────────────────────────

  /**
   * Inject a prompt into a user's session.
   * @param deliver true = send response to user (greeting). false = fire-and-forget (system msg).
   */
  async inject(userId: string, prompt: string, opts?: { deliver?: boolean }): Promise<string | null> {
    const registry = loadUsers();
    const user = registry.byUserId.get(userId);
    if (!user) { logWarn(TAG, `inject: unknown user ${userId}`); return null; }
    const chatId = user.platforms.telegram ?? user.platforms.discord;
    if (!chatId) { logWarn(TAG, `inject: no chatId for ${userId}`); return null; }
    const platform = user.platforms.telegram ? "telegram" : "discord";
    const numericChatId = typeof chatId === "number" ? chatId : parseInt(String(chatId), 10);

    try {
      const session = await this.resolveSession(userId, platform, numericChatId);
      if (!session.transport) { logWarn(TAG, `inject: no transport for ${userId}`); return null; }
      const response = await session.transport.sendPrompt(`${userId}:inject`, prompt, undefined, userId);
      session.messageCount++;
      pushLog(session, `inject (deliver=${opts?.deliver ?? true})`);
      logInfo(TAG, `inject delivered to ${userId} (${response.length} chars, deliver=${opts?.deliver ?? true})`);
      return (opts?.deliver ?? true) ? response : null;
    } catch (err) {
      logWarn(TAG, `inject failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Backwards-compat alias. */
  async injectGreeting(userId: string, prompt: string): Promise<string | null> {
    return this.inject(userId, prompt, { deliver: true });
  }

  // ── Orc session (#932) ─────────────────────────────────────────────────

  getOrcSession(): AgentSession | null { return this.orcSession?.isReady ? this.orcSession : null; }

  async sendUserToOrc(message: string): Promise<string | null> {
    const orc = this.getOrcSession();
    if (!orc) return null;
    this.resetOrcIdle();
    logTrace(TAG, `[USER→Orc] "${message.slice(0, 100)}"`);
    const response = await orc.sendPrompt("orc:user", `[USER] ${message}`);
    logTrace(TAG, `[Orc→USER] "${response.slice(0, 100)}"`);
    return response;
  }

  private async getOrCreateOrc(): Promise<AgentSession> {
    this.resetOrcIdle();
    if (this.orcSession?.isReady) return this.orcSession;
    logInfo(TAG, "Spawning persistent Orc session");
    this.orcSession = await this.runtime!.session("browsie");
    return this.orcSession;
  }

  private resetOrcIdle(): void {
    if (this.orcIdleTimer) clearTimeout(this.orcIdleTimer);
    this.orcIdleTimer = setTimeout(() => this.destroyOrc(), ORC_IDLE_MS);
    (this.orcIdleTimer as NodeJS.Timeout).unref();
  }

  private async destroyOrc(): Promise<void> {
    logInfo(TAG, "Orc idle timeout — destroying session");
    if (this.orcSession) { await this.orcSession.destroy(); this.orcSession = null; }
    if (this.orcIdleTimer) { clearTimeout(this.orcIdleTimer); this.orcIdleTimer = null; }
  }

  // ── Dispatch (background sessions) ─────────────────────────────────────

  dispatch(request: SpinRequest): number {
    const cardTitle = request.title ?? request.goal.slice(0, 80);
    const cardId = request.cardId ?? kanbanEnqueue(cardTitle, request.source, undefined, {
      priority: request.priority ?? "MEDIUM",
      type: request.type,
      parent_id: request.parentCardId,
      deliveryMode: request.deliveryMode,
    });

    if (!this.canDispatch(request.type, cardId)) {
      logInfo(TAG, `${request.type} card:${cardId} queued (concurrency gate)`);
      return cardId;
    }

    this.markRunning(request.type, cardId);
    kanbanRunning(cardId);
    logTrace(TAG, `dispatch ${request.type} card:${cardId} source=${request.source}`);

    const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Register as visible session
    const masterUserId = loadUsers().users.find(u => u.role === "master")?.userId ?? "master";
    const sub = this.createSubSession(masterUserId, "telegram", request.type);
    const session = typeof sub === "string" ? undefined : sub;
    if (session) { session.name = request.title?.slice(0, 20); pushLog(session, `dispatch card:${cardId}`); }

    this.execute(request, cardId, timeout)
      .then(result => {
        logTrace(TAG, `done ${request.type} card:${cardId} result=${result.length} chars`);
        kanbanComplete(cardId, null, result.slice(0, 500));
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn(TAG, `${request.type} card:${cardId} failed: ${msg}`);
        kanbanFail(cardId, msg.slice(0, 1000));
      })
      .finally(() => {
        this.markDone(request.type, cardId);
        if (session) { session.status = "ended"; pushLog(session, "completed"); }
        this.drainQueued();
      });

    return cardId;
  }

  async dispatchAwait(request: SpinRequest): Promise<{ cardId: number; result: string }> {
    const cardTitle = request.title ?? request.goal.slice(0, 80);
    const cardId = request.cardId ?? kanbanEnqueue(cardTitle, request.source, undefined, {
      priority: request.priority ?? "MEDIUM",
      type: request.type,
      parent_id: request.parentCardId,
      deliveryMode: request.deliveryMode,
    });

    this.markRunning(request.type, cardId);
    kanbanRunning(cardId);

    const masterUserId = loadUsers().users.find(u => u.role === "master")?.userId ?? "master";
    const sub = this.createSubSession(masterUserId, "telegram", request.type);
    const session = typeof sub === "string" ? undefined : sub;
    if (session) { session.name = request.title?.slice(0, 20); pushLog(session, `dispatchAwait card:${cardId}`); }

    const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const result = await this.execute(request, cardId, timeout);
      return { cardId, result };
    } finally {
      this.markDone(request.type, cardId);
      if (session) { session.status = "ended"; pushLog(session, "completed"); }
      this.drainQueued();
    }
  }

  spawnChild(parentCardId: number, request: Omit<SpinRequest, "type"> & { type?: SessionType }): number {
    if (request.type === "O") throw new Error("Cannot nest orchestrators");
    return this.dispatch({ ...request, type: "W", parentCardId });
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private drainQueued(): void {
    const queued = kanbanList("queued");
    for (const card of queued) {
      const type = (card.type as SessionType) ?? "T";
      if (this.canDispatch(type, card.id)) {
        this.dispatch({ type, goal: card.title, source: (card.source as SpinRequest["source"]) ?? "task", cardId: card.id });
      }
    }
  }

  private canDispatch(type: SessionType, _cardId: number): boolean {
    const max = MAX_CONCURRENT[type] ?? 5;
    const active = this.running.get(type)?.size ?? 0;
    return active < max;
  }

  private markRunning(type: SessionType, cardId: number): void {
    if (!this.running.has(type)) this.running.set(type, new Set());
    this.running.get(type)!.add(cardId);
  }

  private markDone(type: SessionType, cardId: number): void {
    this.running.get(type)?.delete(cardId);
  }

  private async execute(request: SpinRequest, cardId: number, timeoutMs: number): Promise<string> {
    if (!this.runtime) throw new Error("Spin: runtime not set");

    if (request.type === "O") return this.executeOrc(request, cardId, timeoutMs);

    const agentName = typeAgent(request.type);
    logInfo(TAG, `▶ ${request.type} card:${cardId} agent=${agentName}`);

    const timer = setTimeout(() => {
      logWarn(TAG, `⏱️ ${request.type} card:${cardId} timed out (${Math.round(timeoutMs / 60000)}min)`);
      this.runtime?.interruptSpawn(`spin-${cardId}`);
    }, timeoutMs);

    try {
      const { buildSoulBundle } = await import("./soul-bundle.js");
      const bundle = buildSoulBundle(request.type);
      const fullPrompt = bundle ? `${bundle}\n\n---\n\n${request.goal}` : request.goal;
      const result = await this.runtime.complete(agentName, fullPrompt, { timeoutMs, session: "fresh" });

      // #889: Report token usage to kanban
      const usage = this.runtime.lastUsage;
      if (usage && (usage.input + usage.output) > 0) {
        kanbanAddTokens(cardId, usage.input + usage.output);
      }

      return result || "(no output)";
    } finally {
      clearTimeout(timer);
    }
  }

  private async executeOrc(request: SpinRequest, cardId: number, timeoutMs: number): Promise<string> {
    const { updateBridgeLockField } = await import("./transport/bridge-lock-transport.js");
    updateBridgeLockField("orc_active", cardId);

    const orc = await this.getOrCreateOrc();
    logInfo(TAG, `▶ O card:${cardId} (persistent Orc)`);

    const timer = setTimeout(() => {
      logWarn(TAG, `⏱️ O card:${cardId} timed out (${Math.round(timeoutMs / 60000)}min)`);
    }, timeoutMs);

    try {
      const { buildSoulBundle } = await import("./soul-bundle.js");
      const bundle = buildSoulBundle("O");
      let fullPrompt = bundle ? `${bundle}\n\n---\n\n${request.goal}` : request.goal;

      const { drainOrcNotifications } = await import("./spin-notifications.js");
      const notifications = drainOrcNotifications(cardId);
      if (notifications.length) {
        fullPrompt = notifications.join("\n") + "\n\n" + fullPrompt;
      }

      const result = await orc.sendPrompt("orc:project", fullPrompt);
      return result || "(no output)";
    } finally {
      clearTimeout(timer);
      updateBridgeLockField("orc_active", null);
    }
  }
}

/** Singleton instance. */
export const spin = new Spin();
