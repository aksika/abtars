/**
 * spin.ts — Unified session router (#943, #953).
 * Single flat Map<sessionId, ManagedSession>. No bucketing. No PlatformState.
 */

import { logInfo, logWarn } from "./logger.js";
import { kanbanEnqueue, kanbanRunning, kanbanComplete, kanbanFail, kanbanRetryOrFail, kanbanList, kanbanGetCard, isUnblocked } from "./tasks/kanban-board.js";
import type { SubagentRuntime, AgentSession } from "./subagent-runtime.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import { loadUsers } from "./user-registry.js";
import { getMasterUserId } from "./master-user.js";
import type { ManagedSession, SpinRequest, SessionType } from "./spin-types.js";
import { typeAgent } from "./spin-types.js";
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

  formatList(userId: string, platform: string): string {
    return Sessions.formatList(this.sessions, userId, platform);
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
    const adapter = this._greetingAdapter!;
    let attempt = 0;
    let lastInjectAt = 0;

    const inject = (): void => {
      attempt++;
      lastInjectAt = Date.now();
      adapter.injectMessage({
        platform,
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
        if (session.messageCount > 0) return; // greeting delivered
        if (session.busy) return; // model still thinking — don't retry
        if (attempt >= 3) { logError(TAG, "Greeting failed after 3 attempts"); return; }
        logWarn(TAG, `Greeting attempt ${attempt}/3 — no response, retrying`);
        inject();
      }, 60_000);
    };

    // Event-driven: fire when transport is ready (#1000)
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
      if (s.transport) { try { s.transport.destroy(); } catch {} s.transport = undefined; }
      s.status = "ended";
      s.active = false;
      pushLog(s, "destroyed");
      logInfo(TAG, `Session destroyed: ${userId} id=${s.id}`);
    }
  }

  destroyAll(): void {
    for (const s of this.sessions.values()) {
      if (s.transport) { try { s.transport.destroy(); } catch {} }
    }
    if (this.orcSession) { try { this.orcSession.destroy(); } catch {} this.orcSession = null; }
    this.sessions.clear();
    this.nextIndex = 0;
    logInfo(TAG, "All sessions destroyed (shutdown)");
  }

  // ── inject() ───────────────────────────────────────────────────────────

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

  async injectGreeting(userId: string, prompt: string): Promise<string | null> {
    return this.inject(userId, prompt, { deliver: true });
  }

  // ── Orc ────────────────────────────────────────────────────────────────

  getOrcSession(): AgentSession | null { return this.orcSession?.isReady ? this.orcSession : null; }

  async sendUserToOrc(message: string): Promise<string | null> {
    const orc = this.getOrcSession();
    if (!orc) return null;
    const response = await orc.sendPrompt("orc:user", `[USER] ${message}`);
    return response;
  }

  private async getOrCreateOrc(): Promise<AgentSession> {
    if (this.orcSession?.isReady) return this.orcSession;
    logInfo(TAG, "Spawning persistent Orc session");
    this.orcSession = await this.runtime!.session("browsie");
    return this.orcSession;
  }

  // ── Dispatch ───────────────────────────────────────────────────────────

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

  dispatch(request: SpinRequest): number {
    const cardTitle = request.title ?? request.goal.slice(0, 80);
    const cardId = request.cardId ?? kanbanEnqueue(cardTitle, request.source, undefined, {
      priority: request.priority ?? "MEDIUM", type: request.type,
      parent_id: request.parentCardId, deliveryMode: request.deliveryMode,
      notes: request.callbackPeer ? JSON.stringify({ callback_peer: request.callbackPeer }) : undefined,
      chatId: request.chatId,
    });

    if (!this.canDispatch(request.type, cardId)) {
      logInfo(TAG, `${request.type} card:${cardId} queued (concurrency gate)`);
      return cardId;
    }

    this.markRunning(request.type, cardId);
    kanbanRunning(cardId);

    const masterUserId = getMasterUserId();
    const session = this.getOrCreateVisibleSession(masterUserId, request.type);
    if (session) { session.name = request.title?.slice(0, 20); pushLog(session, `dispatch card:${cardId}`); }

    const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.execute(request, cardId, timeout)
      .then(result => {
        const { drainArtifacts } = require("./transport/artifact-tools.js") as typeof import("./transport/artifact-tools.js");
        const artifacts = drainArtifacts(cardId);
        kanbanComplete(cardId, null, result.slice(0, 500));
        if (request.callbackPeer) {
          const card = kanbanGetCard(cardId);
          fireCallback(request.callbackPeer, cardId, "done", result.slice(0, 500), undefined, artifacts, card?.tokens_used ?? 0);
        }
      })
      .catch(err => {
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
        logWarn(TAG, `${request.type} card:${cardId} failed: ${msg}`);
        kanbanRetryOrFail(cardId, msg);
        if (request.callbackPeer) fireCallback(request.callbackPeer, cardId, "failed", undefined, msg);
      })
      .finally(() => {
        this.markDone(request.type, cardId);
        if (session) { session.status = "ended"; session.active = false; pushLog(session, "completed"); }
        this.drainQueued();
      });

    return cardId;
  }

  async dispatchAwait(request: SpinRequest): Promise<{ cardId: number; result: string }> {
    // #987: enforce concurrency + cooldown gates (same as dispatch)
    if (!this.canDispatch(request.type, 0)) {
      throw new Error(`${request.type} session busy or in cooldown — skipping`);
    }

    const cardTitle = request.title ?? request.goal.slice(0, 80);
    const cardId = request.cardId ?? kanbanEnqueue(cardTitle, request.source, undefined, {
      priority: request.priority ?? "MEDIUM", type: request.type,
      parent_id: request.parentCardId, deliveryMode: request.deliveryMode,
      chatId: request.chatId,
    });

    this.markRunning(request.type, cardId);
    kanbanRunning(cardId);

    const masterUserId = getMasterUserId();
    const session = this.getOrCreateVisibleSession(masterUserId, request.type);
    if (session) { session.name = request.title?.slice(0, 20); pushLog(session, `dispatchAwait card:${cardId}`); }

    const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const result = await this.execute(request, cardId, timeout);
      return { cardId, result };
    } finally {
      this.markDone(request.type, cardId);
      // O-type: session stays alive until Orc idle timeout (visible in /session)
      if (session && request.type !== "O") { session.status = "ended"; session.active = false; pushLog(session, "completed"); }
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
      } catch {}
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

  private async execute(request: SpinRequest, cardId: number, timeoutMs: number): Promise<string> {
    if (!this.runtime) throw new Error("Spin: runtime not set");
    if (request.type === "O") return this.executeOrc(request, cardId, timeoutMs);

    const agentName = request.agent ?? typeAgent(request.type);
    logInfo(TAG, `▶ ${request.type} card:${cardId} agent=${agentName}`);

    const staleMs = parseInt(process.env["WORKER_STALE_MS"] ?? "300000", 10);
    let lastActivityAt = Date.now();

    const timer = setTimeout(() => {
      logWarn(TAG, `⏱️ ${request.type} card:${cardId} timed out`);
      this.runtime?.interruptSpawn(`spin-${cardId}`);
    }, timeoutMs);

    const staleCheck = setInterval(() => {
      if (Date.now() - lastActivityAt > staleMs) {
        clearInterval(staleCheck);
        logWarn(TAG, `⏱️ ${request.type} card:${cardId} stale (no activity ${staleMs / 1000}s)`);
        this.runtime?.interruptSpawn(`spin-${cardId}`);
      }
    }, 60_000);

    try {
      const { buildSoulBundle } = await import("./soul-bundle.js");
      const bundle = buildSoulBundle(request.type);
      let fullPrompt = bundle ? `${bundle}\n\n---\n\n${request.goal}` : request.goal;

      // #891: auto-inject channel messages for W/O sessions
      if (request.type === "W" || request.type === "T") {
        const { channelUnread } = await import("./tasks/kanban-channel.js");
        const workerName = `Worker-${String(cardId).padStart(2, "0")}`;
        const parentCard = request.parentCardId ?? cardId;
        const msgs = channelUnread(parentCard, workerName);
        if (msgs.length > 0) {
          const lines = msgs.map(m => `[${m.from_agent}→${m.to_agent}]${m.directive ? " ⚡" : ""} ${m.message}`);
          fullPrompt = `[CHANNEL — ${msgs.length} message(s) for ${workerName}]\n${lines.join("\n")}\n[/CHANNEL]\n\n${fullPrompt}`;
        }
      }

      const result = (await this.runtime.complete(agentName, fullPrompt, { timeoutMs, session: "fresh" })) || "(no output)";
      if (this.memory) {
        const sid = `${request.type}_card${cardId}`;
        this.memory.recordMessage({ role: "user", content: request.goal, timestamp: Date.now(), userId: "system", sessionId: sid });
        this.memory.recordMessage({ role: "assistant", content: result, timestamp: Date.now(), userId: "system", sessionId: sid });
      }
      return result;
    } finally { clearTimeout(timer); clearInterval(staleCheck); }
  }

  private async executeOrc(request: SpinRequest, cardId: number, timeoutMs: number): Promise<string> {
    const { updateBridgeLockField } = await import("./transport/bridge-lock-transport.js");
    const { setActiveOrcCard } = await import("./transport/orc-tools.js");
    updateBridgeLockField("orc_active", cardId);
    setActiveOrcCard(cardId);
    const orc = await this.getOrCreateOrc();
    logInfo(TAG, `▶ O card:${cardId} (persistent Orc)`);

    // #993: Attach Orc transport to visible session — user can sneak in
    let orcSessionKey = "orc:project"; // fallback
    for (const [, s] of this.sessions) {
      if (s.id.includes("_O_") && s.status !== "ended") {
        s.transport = orc.transport as any;
        s.status = "ready";
        orcSessionKey = s.id; // use proper ManagedSession ID as ACP session key
        break;
      }
    }
    const timer = setTimeout(() => { logWarn(TAG, `⏱️ O card:${cardId} timed out`); }, timeoutMs);
    try {
      const { buildSoulBundle } = await import("./soul-bundle.js");
      const bundle = buildSoulBundle("O");

      // #1005: CONTEXT wrapper (same pattern as Main)
      const { localDateTime } = await import("../utils/local-time.js");
      const context = `[CONTEXT — do not respond to this section]\n[PROJECT] card #${cardId}\n[CURRENT TIME] ${localDateTime()}\n[/CONTEXT]\n\n`;

      let fullPrompt = context + (bundle ? `${bundle}\n\n---\n\n${request.goal}` : request.goal);
      const { drainOrcNotifications } = await import("./spin-notifications.js");
      const notifications = drainOrcNotifications(cardId);
      if (notifications.length) fullPrompt = notifications.join("\n") + "\n\n" + fullPrompt;

      // #891: Orc sees ALL channel messages on its card
      const { channelUnread } = await import("./tasks/kanban-channel.js");
      const orcMsgs = channelUnread(cardId, "Orc");
      if (orcMsgs.length > 0) {
        const lines = orcMsgs.map(m => `[${m.from_agent}→${m.to_agent}]${m.directive ? " ⚡" : ""} ${m.message}`);
        fullPrompt = `[CHANNEL — ${orcMsgs.length} message(s)]\n${lines.join("\n")}\n[/CHANNEL]\n\n${fullPrompt}`;
      }

      const result = (await orc.sendPrompt(orcSessionKey, fullPrompt)) || "(no output)";
      if (this.memory) {
        this.memory.recordMessage({ role: "user", content: request.goal, timestamp: Date.now(), userId: "system", sessionId: orcSessionKey });
        this.memory.recordMessage({ role: "assistant", content: result, timestamp: Date.now(), userId: "system", sessionId: orcSessionKey });
      }
      return result;
    } finally { clearTimeout(timer); updateBridgeLockField("orc_active", null); setActiveOrcCard(null); }
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
