/**
 * spin.ts — Session lifecycle orchestrator (#894, #936).
 * Single gateway for ALL session creation — interactive (A) and non-interactive (T/B/C/O/W/D/H).
 * Resolves which transport handles each inbound message.
 * Fire-and-forget dispatch for background sessions.
 * Orc (O) is persistent with idle timeout (#932).
 */

import { logInfo, logWarn, logTrace } from "./logger.js";
import { kanbanEnqueue, kanbanRunning, kanbanComplete, kanbanFail, kanbanList } from "./tasks/kanban-board.js";
import type { SubagentRuntime, AgentSession } from "./subagent-runtime.js";
import type { SessionManager, SessionType } from "./session-manager.js";
import type { SandboxPolicy } from "./tool-sandbox.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import { loadUsers } from "./user-registry.js";

const TAG = "spin";
const ORC_IDLE_MS = (parseInt(process.env["ORC_IDLE_TIMEOUT_SEC"] ?? "1200", 10)) * 1000; // default 20min
const USER_SESSION_IDLE_MS = parseInt(process.env["USER_SESSION_IDLE_MS"] ?? "7200000", 10); // 2h
const GUEST_SESSION_IDLE_MS = parseInt(process.env["GUEST_SESSION_IDLE_MS"] ?? "1800000", 10); // 30min
const MAX_USER_SESSIONS = parseInt(process.env["MAX_USER_SESSIONS"] ?? "3", 10);
const SESSION_CREATE_TIMEOUT_MS = 30_000;

// ── Interactive session management (#936) ────────────────────────────────────

// ── Interactive session management (#936 + #938) ────────────────────────────────────

export interface SpinRequest {
  type: SessionType;
  goal: string;
  source: "task" | "user" | "agent" | "peer";
  cardId?: number;
  parentCardId?: number;
  deliveryMode?: "silent" | "announce";
  priority?: string;
  tools?: SandboxPolicy;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000; // 30 min

/** Concurrency limits per session type. */
const MAX_CONCURRENT: Partial<Record<SessionType, number>> = {
  T: 1, O: 1, B: 1, D: 1, H: 1, W: 3,
};

export class Spin {
  private running = new Map<SessionType, Set<number>>(); // type → active cardIds
  private runtime: SubagentRuntime | null = null;
  private sessionManager: SessionManager | null = null;

  // Persistent Orc session (#932)
  private orcSession: AgentSession | null = null;
  private orcIdleTimer: ReturnType<typeof setTimeout> | null = null;

  setRuntime(runtime: SubagentRuntime): void { this.runtime = runtime; }
  setSessionManager(sm: SessionManager): void { this.sessionManager = sm; }

  /** Get the live Orc session (for user attach / message routing). */
  getOrcSession(): AgentSession | null { return this.orcSession?.isReady ? this.orcSession : null; }

  // ── Interactive session lifecycle (#936 + #938) ──────────────────────────

  /** Register the master's transport at boot on their active SessionManager session. */
  registerMasterSession(opts: { userId: string; chatId: number; platform: string; transport: IKiroTransport }): void {
    if (!this.sessionManager) return;
    const session = this.sessionManager.getActiveSession(opts.userId, opts.platform as any);
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
    logInfo(TAG, `Master session registered: ${opts.userId} (${opts.platform}:${opts.chatId}${session.pid ? ` pid=${session.pid}` : ""})`);
  }

  /** Resolve the active session for a user. Attaches transport if needed. */
  async resolveSession(userId: string, platform: string, chatId: number): Promise<import("./session-manager.js").ManagedSession> {
    if (!this.sessionManager) throw new Error("Spin: sessionManager not set");
    const session = this.sessionManager.getActiveSession(userId, platform as any);

    // Already has transport → reuse
    if (session.transport) {
      session.lastActiveAt = Date.now();
      return session;
    }

    // Already ended — recreate will happen via SessionManager on /session new
    if (session.status === "ended") {
      throw new Error("Session ended — use /session new");
    }

    // Need to create transport
    session.status = "creating";
    session.chatId = chatId;
    session.userId = userId;
    session.platform = platform;
    const registry = loadUsers();
    const user = registry.byUserId.get(userId);
    const role = user?.role ?? "guest";
    session.idleTimeoutMs = role === "master" ? Infinity : role === "guest" ? GUEST_SESSION_IDLE_MS : USER_SESSION_IDLE_MS;
    session.delivery = role === "master" ? "streaming" : "simple";

    logInfo(TAG, `Creating transport for ${userId} (${role}, idle=${session.idleTimeoutMs}ms)`);

    try {
      const agentSession = await Promise.race([
        this.runtime!.session("professor", userId),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Session creation timed out")), SESSION_CREATE_TIMEOUT_MS)),
      ]);
      session.transport = agentSession.transport!;
      session.status = "ready";
      session.lastActiveAt = Date.now();
      // Extract PID from underlying CLI process if available
      const t = session.transport as any;
      session.pid = t?._rawClient?.pid ?? t?.agent?.pid ?? undefined;
      logInfo(TAG, `Session ready: ${userId} id=${session.id}${session.pid ? ` pid=${session.pid}` : ""}`);
      return session;
    } catch (err) {
      session.status = "ended";
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `Session creation failed for ${userId}: ${msg}`);
      throw err;
    }
  }

  /** Destroy a specific session's transport (idle timeout, error, manual). */
  destroySession(userId: string, sessionId?: string): void {
    if (!this.sessionManager) return;
    const sessions = this.sessionManager.listAllSessions();
    for (const s of sessions) {
      if (s.userId !== userId) continue;
      if (sessionId && s.id !== sessionId) continue;
      if (s.idleTimeoutMs === Infinity) continue; // never kill master primary
      if (s.transport) {
        try { s.transport.destroy(); } catch {}
        s.transport = undefined;
      }
      s.status = "ended";
      logInfo(TAG, `Session destroyed: ${userId} id=${s.id}`);
    }
  }

  /** Inject a greeting/prompt into a user's session. Creates session if needed. */
  async injectGreeting(userId: string, prompt: string): Promise<string | null> {
    const registry = loadUsers();
    const user = registry.byUserId.get(userId);
    if (!user) { logWarn(TAG, `injectGreeting: unknown user ${userId}`); return null; }
    const chatId = user.platforms.telegram ?? user.platforms.discord;
    if (!chatId) { logWarn(TAG, `injectGreeting: no chatId for ${userId}`); return null; }
    const platform = user.platforms.telegram ? "telegram" : "discord";
    const numericChatId = typeof chatId === "number" ? chatId : parseInt(String(chatId), 10);

    try {
      const session = await this.resolveSession(userId, platform, numericChatId);
      if (!session.transport) { logWarn(TAG, `injectGreeting: no transport for ${userId}`); return null; }
      const response = await session.transport.sendPrompt(`${userId}:greeting`, prompt, undefined, userId);
      logInfo(TAG, `Greeting delivered to ${userId} (${response.length} chars)`);
      return response;
    } catch (err) {
      logWarn(TAG, `injectGreeting failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Dispatch a session. Fire-and-forget.
   * Returns cardId immediately. Session runs autonomously.
   */
  dispatch(request: SpinRequest): number {
    const cardId = request.cardId ?? kanbanEnqueue(request.goal, request.source, undefined, {
      priority: request.priority ?? "MEDIUM",
      type: request.type,
      parent_id: request.parentCardId,
    });

    if (!this.canDispatch(request.type, cardId)) {
      logInfo(TAG, `${request.type} card:${cardId} queued (concurrency gate)`);
      return cardId;
    }

    this.markRunning(request.type, cardId);
    kanbanRunning(cardId);
    logTrace(TAG, `dispatch ${request.type} card:${cardId} source=${request.source} goal="${request.goal.slice(0, 80)}"`);

    const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Register session for /session visibility
    if (this.sessionManager) {
      if (request.type === "O") {
        this.sessionManager.createSession("master", "telegram", "O");
      } else {
        this.sessionManager.createSubSession("master", "telegram", request.type);
      }
    }

    this.execute(request, cardId, timeout)
      .then((result) => {
        logTrace(TAG, `done ${request.type} card:${cardId} result=${result.length} chars`);
        kanbanComplete(cardId, null, result.slice(0, 500));
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn(TAG, `${request.type} card:${cardId} failed: ${msg}`);
        kanbanFail(cardId, msg.slice(0, 1000));
      })
      .finally(() => {
        this.markDone(request.type, cardId);
        // End non-Orc sessions (Orc stays persistent)
        if (request.type !== "O" && this.sessionManager) {
          this.sessionManager.endSession("master", "telegram");
        }
        this.drainQueued();
      });

    return cardId;
  }

  /**
   * Dispatch and await result. For callers that need the response (e.g. task post-processing).
   * Caller owns kanban completion/failure updates.
   */
  async dispatchAwait(request: SpinRequest): Promise<{ cardId: number; result: string }> {
    const cardId = request.cardId ?? kanbanEnqueue(request.goal, request.source, undefined, {
      priority: request.priority ?? "MEDIUM",
      type: request.type,
      parent_id: request.parentCardId,
    });

    this.markRunning(request.type, cardId);
    kanbanRunning(cardId);

    if (this.sessionManager) {
      this.sessionManager.createSubSession("master", "telegram", request.type);
    }

    const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const result = await this.execute(request, cardId, timeout);
      return { cardId, result };
    } finally {
      this.markDone(request.type, cardId);
      if (this.sessionManager) this.sessionManager.endSession("master", "telegram");
      this.drainQueued();
    }
  }

  /** Only callable by O-session — spawn child workers. */
  spawnChild(parentCardId: number, request: Omit<SpinRequest, "type"> & { type?: SessionType }): number {
    if (request.type === "O") throw new Error("Cannot nest orchestrators");
    return this.dispatch({ ...request, type: "W", parentCardId });
  }

  // ── Persistent Orc (#932) ──────────────────────────────────────────────

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
    if (this.orcSession) {
      await this.orcSession.destroy();
      this.orcSession = null;
    }
    if (this.sessionManager) this.sessionManager.endSession("master", "telegram");
    if (this.orcIdleTimer) { clearTimeout(this.orcIdleTimer); this.orcIdleTimer = null; }
  }

  /** Send a user message to Orc (when user is attached to O session). */
  async sendUserToOrc(message: string): Promise<string | null> {
    const orc = this.getOrcSession();
    if (!orc) return null;
    this.resetOrcIdle();
    logTrace(TAG, `[USER→Orc] "${message.slice(0, 100)}"`);
    const response = await orc.sendPrompt("orc:user", `[USER] ${message}`);
    logTrace(TAG, `[Orc→USER] "${response.slice(0, 100)}"`);
    return response;
  }

  // ── Internal ───────────────────────────────────────────────────────────

  /** Check queued cards and dispatch any that fit concurrency limits. */
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
    logTrace(TAG, `gate ${type}: active=${active} max=${max}`);
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

    // #932: Orc uses persistent session
    if (request.type === "O") {
      return this.executeOrc(request, cardId, timeoutMs);
    }

    // All non-Orc: browsie model, fire-and-forget
    const agentName = "browsie";

    logInfo(TAG, `▶ ${request.type} card:${cardId} agent=${agentName}`);
    logTrace(TAG, `execute card:${cardId} timeout=${Math.round(timeoutMs / 1000)}s goal="${request.goal.slice(0, 120)}"`);

    const timer = setTimeout(() => {
      logWarn(TAG, `⏱️ ${request.type} card:${cardId} timed out (${Math.round(timeoutMs / 60000)}min)`);
      this.runtime?.interruptSpawn(`spin-${cardId}`);
    }, timeoutMs);

    try {
      const { buildSoulBundle } = await import("./soul-bundle.js");
      const bundle = buildSoulBundle(request.type);
      const fullPrompt = bundle ? `${bundle}\n\n---\n\n${request.goal}` : request.goal;

      const result = await this.runtime.complete(agentName, fullPrompt, {
        timeoutMs,
        session: "fresh",
      });
      return result || "(no output)";
    } finally {
      clearTimeout(timer);
    }
  }

  /** Execute via persistent Orc session. */
  private async executeOrc(request: SpinRequest, cardId: number, timeoutMs: number): Promise<string> {
    const { updateBridgeLockField } = await import("./transport/bridge-lock-transport.js");
    updateBridgeLockField("orc_active", cardId);

    const orc = await this.getOrCreateOrc();

    // Clear context if session was previously used (new project)
    if (orc && "hasAssistantMessages" in orc && typeof (orc as any).hasAssistantMessages === "function") {
      if ((orc as any).hasAssistantMessages()) {
        logInfo(TAG, "Orc: new project — clearing prior context");
        if ("resetContext" in orc && typeof (orc as any).resetContext === "function") {
          (orc as any).resetContext();
        }
      }
    }

    logInfo(TAG, `▶ O card:${cardId} (persistent Orc)`);
    logTrace(TAG, `orc execute card:${cardId} timeout=${Math.round(timeoutMs / 1000)}s goal="${request.goal.slice(0, 120)}"`);

    const timer = setTimeout(() => {
      logWarn(TAG, `⏱️ O card:${cardId} timed out (${Math.round(timeoutMs / 60000)}min)`);
    }, timeoutMs);

    try {
      const { buildSoulBundle } = await import("./soul-bundle.js");
      const bundle = buildSoulBundle("O");
      let fullPrompt = bundle ? `${bundle}\n\n---\n\n${request.goal}` : request.goal;

      // #907: Inject buffered worker notifications
      const { drainOrcNotifications } = await import("./spin-notifications.js");
      const notifications = drainOrcNotifications(cardId);
      if (notifications.length) {
        logTrace(TAG, `orc: injecting ${notifications.length} worker notifications`);
        fullPrompt = notifications.join("\n") + "\n\n" + fullPrompt;
      }

      logTrace(TAG, `orc prompt: "${fullPrompt.slice(0, 200)}"`);
      const result = await orc.sendPrompt("orc:project", fullPrompt);
      logTrace(TAG, `orc result: "${result.slice(0, 100)}" (${result.length} chars)`);
      return result || "(no output)";
    } finally {
      clearTimeout(timer);
      updateBridgeLockField("orc_active", null);
      // Don't destroy Orc — stays alive for follow-ups. Idle timer handles cleanup.
    }
  }
}

/** Singleton instance. */
export const spin = new Spin();
