/**
 * spin-sessions.ts — Session CRUD on a flat Map<id, ManagedSession> (#953).
 * No PlatformState, no bucketing. Filter/find on the one map.
 *
 * #1540: closure-backed registry owner. The map and the allocation counter
 * live only inside createSpinSessionRegistry(); callers get narrow operations
 * and read-only listings and can never mutate the backing collection.
 */

import type { ManagedSession, SessionType } from "./spin-types.js";
import { sessionType, sessionCreatedAt, typeLabel } from "./spin-types.js";
import { logDebug } from "./logger.js";
import { logAndSwallow } from "./log-and-swallow.js";

const MAX_LOG = 5;
const TAG = "spin-sessions";

/**
 * Named rejection type for operator lifecycle commands. Carries the existing
 * user-facing strings; never an ambiguous optional handle.
 */
export type SessionRejection = string;

export function pushLog(session: ManagedSession, event: string): void {
  session.log.push(`${new Date().toISOString().slice(11, 19)} ${event}`);
  if (session.log.length > MAX_LOG) session.log.shift();
}

/**
 * #1502 §7: cancel any active execution bound to the session and release its
 * transport. Called by endSession/killSession so a terminating session does
 * not leave a Pi execution running or a transient transport cached. Both the
 * control's requestCancel and the transport release are idempotent / guarded.
 */
export function cancelSessionExecution(session: ManagedSession, reason: import("./swarm-executor-types.js").CancelReason): void {
  if (session.activeExecutionId) {
    const executionId = session.activeExecutionId;
    void import("./transport/tool-registry.js")
      .then(({ revokeSealedSecretExecution }) => { revokeSealedSecretExecution(executionId); })
      .catch(() => { /* terminal cleanup is best effort */ });
  }
  const ctrl = session.executionControl;
  if (ctrl && !ctrl.terminal) {
    void ctrl.requestCancel(reason).catch(err => logAndSwallow(TAG, `cancel session execution`, err));
  }
  const release = session.releaseTransport;
  if (release) {
    try { void release(); } catch { /* best effort */ }
  }
}

export function isHollow(session: ManagedSession): boolean { return !!session.peer; }

export interface SessionAllocation {
  type: SessionType;
  userId: string;
  platform: string;
  chatId: number;
  active?: boolean;
  motherId?: string;
}

/**
 * Closure-backed session registry (#1540). The concrete Map and nextIndex live
 * inside the factory; every allocation commits the counter and returns the
 * required handle, so no caller can double-allocate or drift the index.
 */
export interface SpinSessionRegistry {
  /** #1330: active session for (userId, platform), auto-creating the initial Main. */
  getOrCreateActive(userId: string, platform: string, chatId?: number): ManagedSession;
  /** Raw allocation: Main auto-create, Dreamy, external Pi generation sessions. */
  allocate(spec: SessionAllocation): ManagedSession;
  /** Interactive session creation (deactivates the current active). */
  create(userId: string, platform: string, type: SessionType, chatId?: number): ManagedSession | SessionRejection;
  /** Non-active sub-session (O/D/K children, motherId set to the active session). */
  createSub(userId: string, platform: string, type: SessionType, chatId?: number): ManagedSession | SessionRejection;
  /** #1330: hollow peer session — visible, transportless, never active. */
  createHollow(userId: string, platform: string, type: SessionType, chatId: number, peer: string, remoteSessionId: string): ManagedSession | SessionRejection;
  getById(sessionId: string): ManagedSession | undefined;
  /** #1336: look up a session by global shortIndex across all platforms. Returns undefined if not found or ended. */
  getByGlobalIndex(index: number): ManagedSession | undefined;
  /** #1635: resolve the session an indexed lifecycle command will target,
   * WITHOUT ending it. Mirrors `findAddressableSession` so callers can run a
   * pre-teardown (e.g. coding-session resource release) before finalizing. */
  resolveAddressable(userId: string, platform: string, index?: number): ManagedSession | undefined;
  switch(userId: string, platform: string, index: number): ManagedSession | SessionRejection;
  /** End an addressable session; reconciles the local active/Main after termination. */
  end(userId: string, platform: string, index?: number): ManagedSession | SessionRejection;
  kill(userId: string, platform: string, index: number): ManagedSession | SessionRejection;
  pause(userId: string, platform: string, index?: number): ManagedSession | SessionRejection;
  resume(userId: string, platform: string, index?: number): ManagedSession | SessionRejection;
  /** Live sessions of one (userId, platform), newest snapshot array. */
  list(userId: string, platform: string): readonly ManagedSession[];
  /** All live sessions across platforms, newest snapshot array. */
  listAll(): readonly ManagedSession[];
  format(userId: string, platform: string, showAll?: boolean): string;
  /** #1248: prune ended sessions older than maxAgeMs. */
  pruneEnded(now: number, maxAgeMs: number): void;
  /** #1540: immediate map removal (call-terminated sessions). Ends nothing itself. */
  remove(sessionId: string): boolean;
  clear(): void;
}

export function createSpinSessionRegistry(options: { maxTotalSessions: number }): SpinSessionRegistry {
  const sessions = new Map<string, ManagedSession>();
  let nextIndex = 0;
  const maxTotalSessions = options.maxTotalSessions;

  function allocate(type: SessionType, userId: string, platform: string, chatId: number, opts?: { active?: boolean; motherId?: string }): ManagedSession {
    const idx = nextIndex + 1;
    nextIndex = idx;
    const ts = Math.floor(Date.now() / 1000);
    const session: ManagedSession = {
      id: `${ts}_${type}_${String(idx).padStart(2, "0")}`,
      userId, platform, chatId,
      delivery: "simple",
      active: opts?.active ?? false,
      status: "ready",
      idleTimeoutMs: 7200000,
      lastActiveAt: Date.now(),
      motherId: opts?.motherId,
      messageCount: 0, tokenCount: 0, toolCallCount: 0,
      log: [],
      shortIndex: idx,
      // #1654: reasoning display off by default — quiet unless /thinking show.
      showThinking: false,
      // Pipeline state defaults (#1040)
      busy: false, queue: [], fullMode: false, pendingStart: false,
      seen: false, compacting: false, ctxWarned: false, compactFailures: 0,
      primingTerms: [], completions: [],
      // #1332/#1361: Steering queue and acceptance gate
      instructionQueue: [],
      steeringAccepting: false,
    };
    sessions.set(session.id, session);
    pushLog(session, "created");
    return session;
  }

  function getActiveSession(userId: string, platform: string): ManagedSession | undefined {
    for (const s of sessions.values()) {
      if (s.userId === userId && s.platform === platform && s.active && s.status !== "ended") return s;
    }
    return undefined;
  }

  /**
   * #1330: Find a session addressable by the owner of (userId, platform).
   * All indexed lifecycle commands (switch, end, kill, pause, resume) must
   * select a target within the caller's platform scope. A globally visible
   * index does not authorize another platform to mutate or attach to a session.
   */
  function findAddressableSession(userId: string, platform: string, index: number): ManagedSession | undefined {
    return [...sessions.values()].find(s =>
      s.shortIndex === index &&
      s.userId === userId &&
      s.platform === platform &&
      s.status !== "ended",
    );
  }

  /** #1635 — resolve the indexed target without ending it (active session when
   * no index given), exactly as end/pause/resume would. */
  function resolveAddressable(userId: string, platform: string, index?: number): ManagedSession | undefined {
    const targetIdx = index ?? getActiveSession(userId, platform)?.shortIndex;
    if (!targetIdx) return undefined;
    return findAddressableSession(userId, platform, targetIdx);
  }

  /**
   * Post-termination reconciliation — shared by end and kill.
   * Scope is the target's (userId, platform) only. Maintains exactly one local
   * Main, activates a replacement when the target was active or no local active
   * remains, and allocates a new Main only when none exists locally.
   */
  function reconcileAfterTermination(userId: string, platform: string, chatId: number, wasActive: boolean): void {
    const localLive = [...sessions.values()].filter(
      s => s.userId === userId && s.platform === platform && s.status !== "ended",
    );
    const localActive = localLive.find(s => s.active);
    let localMain = localLive.find(s => sessionType(s) === "A");

    if (!localMain) {
      const replacementActive = wasActive || !localActive;
      allocate("A", userId, platform, chatId, { active: replacementActive });
    } else if ((wasActive || !localActive) && !localMain.active) {
      localMain.active = true;
    }
  }

  return {
    getOrCreateActive(userId, platform, chatId = 0) {
      let s = getActiveSession(userId, platform);
      if (!s) {
        s = allocate("A", userId, platform, chatId, { active: true });
      }
      return s;
    },

    allocate(spec) {
      return allocate(spec.type, spec.userId, spec.platform, spec.chatId, { active: spec.active, motherId: spec.motherId });
    },

    create(userId, platform, type, chatId = 0) {
      const alive = [...sessions.values()].filter(s => s.status !== "ended");
      if (alive.length >= maxTotalSessions) return `Max sessions reached (${maxTotalSessions}). End or kill a session first.`;

      // Deactivate current active
      const cur = getActiveSession(userId, platform);
      if (cur) cur.active = false;

      return allocate(type, userId, platform, chatId, { active: true });
    },

    createSub(userId, platform, type, chatId = 0) {
      const alive = [...sessions.values()].filter(s => s.status !== "ended");
      if (alive.length >= maxTotalSessions) return `Max sessions reached — auto-spawn skipped.`;

      const active = getActiveSession(userId, platform);
      return allocate(type, userId, platform, chatId, { active: false, motherId: active?.id });
    },

    createHollow(userId, platform, type, chatId, peer, remoteSessionId) {
      const alive = [...sessions.values()].filter(s => s.status !== "ended");
      if (alive.length >= maxTotalSessions) return `Max sessions reached — cannot create hollow session.`;

      const session = allocate(type, userId, platform, chatId, { active: false });
      session.peer = peer;
      session.remoteSessionId = remoteSessionId;
      pushLog(session, `hollow (${peer})`);
      return session;
    },

    getById(sessionId) {
      return sessions.get(sessionId);
    },

    getByGlobalIndex(index) {
      for (const s of sessions.values()) {
        if (s.shortIndex === index && s.status !== "ended") return s;
      }
      return undefined;
    },

    resolveAddressable(userId, platform, index) {
      return resolveAddressable(userId, platform, index);
    },

    switch(userId, platform, index) {
      const target = findAddressableSession(userId, platform, index);
      if (!target) return `Session #${index} not found on ${platform}.`;
      const cur = getActiveSession(userId, platform);
      if (cur && cur.id !== target.id) cur.active = false;
      target.active = true;
      return target;
    },

    end(userId, platform, index) {
      const targetIdx = index ?? getActiveSession(userId, platform)?.shortIndex;
      if (!targetIdx) return `No active session found.`;
      const target = findAddressableSession(userId, platform, targetIdx);
      if (!target) return `Session #${targetIdx} not found on ${platform}.`;

      cancelSessionExecution(target, "session_end");
      const wasActive = target.active;
      target.status = "ended";
      target.active = false;
      pushLog(target, "ended");

      reconcileAfterTermination(userId, platform, target.chatId, wasActive);
      return target;
    },

    kill(userId, platform, index) {
      const target = findAddressableSession(userId, platform, index);
      if (!target) return `Session #${index} not found on ${platform}.`;

      cancelSessionExecution(target, "operator");
      const wasActive = target.active;
      target.status = "ended";
      target.active = false;
      pushLog(target, "killed");

      reconcileAfterTermination(userId, platform, target.chatId, wasActive);
      return target;
    },

    pause(userId, platform, index) {
      const targetIdx = index ?? getActiveSession(userId, platform)?.shortIndex;
      if (!targetIdx) return `No active session found.`;
      const target = findAddressableSession(userId, platform, targetIdx);
      if (!target) return `Session #${targetIdx} not found on ${platform}.`;
      if (target.status === "paused") return `Session #${targetIdx} is already paused.`;
      target.status = "paused";
      pushLog(target, "paused");
      return target;
    },

    resume(userId, platform, index) {
      const targetIdx = index ?? getActiveSession(userId, platform)?.shortIndex;
      if (!targetIdx) return `No active session found.`;
      const target = findAddressableSession(userId, platform, targetIdx);
      if (!target) return `Session #${targetIdx} not found on ${platform}.`;
      if (target.status !== "paused") return `Session #${targetIdx} is not paused.`;
      target.status = "ready";
      pushLog(target, "resumed");
      return target;
    },

    list(userId, platform) {
      return [...sessions.values()].filter(s => s.userId === userId && s.platform === platform && s.status !== "ended");
    },

    listAll() {
      return [...sessions.values()].filter(s => s.status !== "ended");
    },

    format(userId, platform, showAll = false) {
      const list = showAll ? [...sessions.values()].filter(s => s.status !== "ended")
        : [...sessions.values()].filter(s => s.userId === userId && s.platform === platform && s.status !== "ended");
      if (list.length === 0) return "No active sessions.";
      return list.map(s => {
        const marker = s.active && s.userId === userId ? " *" : "";
        const owner = showAll && s.userId !== userId ? ` (${s.userId})` : "";
        const bg = !s.active && sessionType(s) !== "A" ? " (bg)" : "";
        const paused = s.status === "paused" ? " ⏸" : "";
        const remote = s.peer ? ` (remote: ${s.peer})` : "";
        const model = s.model ? ` ${s.model}` : "";
        const nm = s.name ? ` "${s.name}"` : "";
        const time = new Date(sessionCreatedAt(s)).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        const idle = s.busy ? "busy" : `idle ${Math.round((Date.now() - s.lastActiveAt) / 60000)}m`;
        const metrics = s.messageCount ? ` | ${s.messageCount} msgs` : "";
        return `#${s.shortIndex} ${typeLabel(sessionType(s))}${owner}${nm}${remote}${bg}${model} — ${time}${paused}${marker} | ${idle}${metrics}`;
      }).join("\n");
    },

    pruneEnded(now, maxAgeMs) {
      for (const [id, s] of sessions) {
        const endedAt = ((s as unknown as Record<string, unknown>)["endedAt"] as number | undefined) ?? s.lastActiveAt;
        if (s.status === "ended" && now - endedAt > maxAgeMs) {
          sessions.delete(id);
          logDebug(TAG, `Pruned ended session: ${s.userId} id=${id}`);
        }
      }
    },

    remove(sessionId) {
      return sessions.delete(sessionId);
    },

    clear() {
      sessions.clear();
      nextIndex = 0;
    },
  };
}
