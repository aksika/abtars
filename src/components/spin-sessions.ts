/**
 * spin-sessions.ts — Session CRUD on a flat Map<id, ManagedSession> (#953).
 * No PlatformState, no bucketing. Filter/find on the one map.
 */

import type { ManagedSession, SessionType } from "./spin-types.js";
import { sessionType, sessionCreatedAt, typeLabel } from "./spin-types.js";

const MAX_LOG = 5;

export function pushLog(session: ManagedSession, event: string): void {
  session.log.push(`${new Date().toISOString().slice(11, 19)} ${event}`);
  if (session.log.length > MAX_LOG) session.log.shift();
}

export function allocateSession(
  sessions: Map<string, ManagedSession>, nextIndex: number,
  type: SessionType, userId: string, platform: string, chatId: number,
  opts?: { active?: boolean; motherId?: string },
): { session: ManagedSession; nextIndex: number } {
  const idx = nextIndex + 1;
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
    // Pipeline state defaults (#1040)
    busy: false, queue: [], fullMode: false, pendingStart: false,
    seen: false, compacting: false, ctxWarned: false, compactFailures: 0,
    primingTerms: [], completions: [],
    // #1332: Steering queue
    instructionQueue: [],
  };
  sessions.set(session.id, session);
  pushLog(session, "created");
  return { session, nextIndex: idx };
}

export function getActiveSession(sessions: Map<string, ManagedSession>, userId: string, platform: string): ManagedSession | undefined {
  for (const s of sessions.values()) {
    if (s.userId === userId && s.platform === platform && s.active && s.status !== "ended") return s;
  }
  return undefined;
}

export function createSession(
  sessions: Map<string, ManagedSession>, nextIndex: number,
  userId: string, platform: string, type: SessionType, chatId: number, maxSessions: number,
): { session: ManagedSession; nextIndex: number } | string {
  const alive = [...sessions.values()].filter(s => s.status !== "ended");
  if (alive.length >= maxSessions) return `Max sessions reached (${maxSessions}). End or kill a session first.`;

  // Deactivate current active
  const cur = getActiveSession(sessions, userId, platform);
  if (cur) cur.active = false;

  const result = allocateSession(sessions, nextIndex, type, userId, platform, chatId, { active: true });
  return result;
}

export function createSubSession(
  sessions: Map<string, ManagedSession>, nextIndex: number,
  userId: string, platform: string, type: SessionType, chatId: number, maxSessions: number,
): { session: ManagedSession; nextIndex: number } | string {
  const alive = [...sessions.values()].filter(s => s.status !== "ended");
  if (alive.length >= maxSessions) return `Max sessions reached — auto-spawn skipped.`;

  const active = getActiveSession(sessions, userId, platform);
  return allocateSession(sessions, nextIndex, type, userId, platform, chatId, { active: false, motherId: active?.id });
}

/**
 * #1330: Find a session addressable by the owner of (userId, platform).
 * All indexed lifecycle commands (switch, end, kill, pause, resume) must
 * select a target within the caller's platform scope. A globally visible
 * index does not authorize another platform to mutate or attach to a session.
 */
function findAddressableSession(
  sessions: Map<string, ManagedSession>,
  userId: string, platform: string, index: number,
): ManagedSession | undefined {
  return [...sessions.values()].find(s =>
    s.shortIndex === index &&
    s.userId === userId &&
    s.platform === platform &&
    s.status !== "ended",
  );
}

export function isHollow(session: ManagedSession): boolean { return !!session.peer; }

export function createHollowSession(
  sessions: Map<string, ManagedSession>, nextIndex: number,
  userId: string, platform: string, type: SessionType, chatId: number,
  peer: string, remoteSessionId: string, maxSessions: number,
): { session: ManagedSession; nextIndex: number } | string {
  const alive = [...sessions.values()].filter(s => s.status !== "ended");
  if (alive.length >= maxSessions) return `Max sessions reached — cannot create hollow session.`;

  const result = allocateSession(sessions, nextIndex, type, userId, platform, chatId, { active: false });
  result.session.peer = peer;
  result.session.remoteSessionId = remoteSessionId;
  pushLog(result.session, `hollow (${peer})`);
  return result;
}

export function switchSession(sessions: Map<string, ManagedSession>, userId: string, platform: string, index: number): ManagedSession | string {
  const target = findAddressableSession(sessions, userId, platform, index);
  if (!target) return `Session #${index} not found on ${platform}.`;
  const cur = getActiveSession(sessions, userId, platform);
  if (cur && cur.id !== target.id) cur.active = false;
  target.active = true;
  return target;
}

/**
 * Post-termination reconciliation — shared by endSession and killSession.
 * Scope is the target's (userId, platform) only. Maintains exactly one local
 * Main, activates a replacement when the target was active or no local active
 * remains, and allocates a new Main only when none exists locally.
 */
function reconcileAfterTermination(
  sessions: Map<string, ManagedSession>,
  nextIndex: number,
  userId: string,
  platform: string,
  chatId: number,
  wasActive: boolean,
): number {
  const localLive = [...sessions.values()].filter(
    s => s.userId === userId && s.platform === platform && s.status !== "ended",
  );
  const localActive = localLive.find(s => s.active);
  let localMain = localLive.find(s => sessionType(s) === "A");

  if (!localMain) {
    const replacementActive = wasActive || !localActive;
    const result = allocateSession(sessions, nextIndex, "A", userId, platform, chatId, { active: replacementActive });
    nextIndex = result.nextIndex;
  } else if ((wasActive || !localActive) && !localMain.active) {
    localMain.active = true;
  }

  return nextIndex;
}

export function endSession(sessions: Map<string, ManagedSession>, nextIndex: number, userId: string, platform: string, index?: number): { ended: ManagedSession; nextIndex: number } | string {
  const targetIdx = index ?? getActiveSession(sessions, userId, platform)?.shortIndex;
  if (!targetIdx) return `No active session found.`;
  const target = findAddressableSession(sessions, userId, platform, targetIdx);
  if (!target) return `Session #${targetIdx} not found on ${platform}.`;

  const wasActive = target.active;
  target.status = "ended";
  target.active = false;
  pushLog(target, "ended");

  nextIndex = reconcileAfterTermination(sessions, nextIndex, userId, platform, target.chatId, wasActive);
  return { ended: target, nextIndex };
}

export function killSession(sessions: Map<string, ManagedSession>, nextIndex: number, userId: string, platform: string, index: number): { killed: ManagedSession; nextIndex: number } | string {
  const target = findAddressableSession(sessions, userId, platform, index);
  if (!target) return `Session #${index} not found on ${platform}.`;

  const wasActive = target.active;
  target.status = "ended";
  target.active = false;
  pushLog(target, "killed");

  nextIndex = reconcileAfterTermination(sessions, nextIndex, userId, platform, target.chatId, wasActive);
  return { killed: target, nextIndex };
}

export function pauseSession(sessions: Map<string, ManagedSession>, userId: string, platform: string, index?: number): ManagedSession | string {
  const targetIdx = index ?? getActiveSession(sessions, userId, platform)?.shortIndex;
  if (!targetIdx) return `No active session found.`;
  const target = findAddressableSession(sessions, userId, platform, targetIdx);
  if (!target) return `Session #${targetIdx} not found on ${platform}.`;
  if (target.status === "paused") return `Session #${targetIdx} is already paused.`;
  target.status = "paused";
  pushLog(target, "paused");
  return target;
}

export function resumeSession(sessions: Map<string, ManagedSession>, userId: string, platform: string, index?: number): ManagedSession | string {
  const targetIdx = index ?? getActiveSession(sessions, userId, platform)?.shortIndex;
  if (!targetIdx) return `No active session found.`;
  const target = findAddressableSession(sessions, userId, platform, targetIdx);
  if (!target) return `Session #${targetIdx} not found on ${platform}.`;
  if (target.status !== "paused") return `Session #${targetIdx} is not paused.`;
  target.status = "ready";
  pushLog(target, "resumed");
  return target;
}

export function listSessions(sessions: Map<string, ManagedSession>, userId: string, platform: string): ManagedSession[] {
  return [...sessions.values()].filter(s => s.userId === userId && s.platform === platform && s.status !== "ended");
}

export function listAllSessions(sessions: Map<string, ManagedSession>): ManagedSession[] {
  return [...sessions.values()].filter(s => s.status !== "ended");
}

export function getSessionById(sessions: Map<string, ManagedSession>, sessionId: string): ManagedSession | undefined {
  return sessions.get(sessionId);
}

export function formatList(sessions: Map<string, ManagedSession>, userId: string, platform: string, showAll = false): string {
  const list = showAll ? listAllSessions(sessions) : listSessions(sessions, userId, platform);
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
}
