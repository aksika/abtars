/**
 * spin-sessions.ts — Session CRUD: create/end/switch/list/format (#943).
 * Pure data manipulation on a sessions Map. No async, no transports.
 * Separately testable. Used by Spin class.
 */

import type { ManagedSession, SessionType } from "./spin-types.js";
import { sessionType, sessionCreatedAt, typeLabel } from "./spin-types.js";
import type { Platform } from "../types/platform.js";

export interface PlatformState {
  sessions: ManagedSession[];
  activeIndex: number;
  nextIndex: number;
}

const MAX_LOG = 5;

export function pushLog(session: ManagedSession, event: string): void {
  session.log.push(`${new Date().toISOString().slice(11, 19)} ${event}`);
  if (session.log.length > MAX_LOG) session.log.shift();
}

export function stateKey(userId: string, platform: string): string {
  return `${userId}:${platform}`;
}

export function getOrCreateState(states: Map<string, PlatformState>, userId: string, platform: string): PlatformState {
  const key = stateKey(userId, platform);
  let state = states.get(key);
  if (!state) {
    state = { sessions: [], activeIndex: 1, nextIndex: 1 };
    states.set(key, state);
    const main = allocateSession(state, "A", true, userId, platform, 0);
    state.activeIndex = main.shortIndex;
  }
  return state;
}

export function allocateSession(
  state: PlatformState, type: SessionType, isTransport: boolean,
  userId: string, platform: string, chatId: number, motherId?: string,
): ManagedSession {
  const idx = state.nextIndex++;
  const ts = Math.floor(Date.now() / 1000);
  const session: ManagedSession = {
    id: `${ts}_${type}_${String(idx).padStart(2, "0")}`,
    userId, platform, chatId,
    delivery: "simple",
    status: "ready",
    idleTimeoutMs: 7200000,
    lastActiveAt: Date.now(),
    motherId,
    messageCount: 0, tokenCount: 0, toolCallCount: 0,
    log: [],
    shortIndex: idx,
    isTransport,
  };
  state.sessions.push(session);
  pushLog(session, "created");
  return session;
}

export function getActiveSession(states: Map<string, PlatformState>, userId: string, platform: string): ManagedSession {
  const state = getOrCreateState(states, userId, platform);
  return state.sessions.find(s => s.shortIndex === state.activeIndex && s.status !== "ended") ?? state.sessions[0]!;
}

export function getActiveSessionId(states: Map<string, PlatformState>, userId: string, platform: string): string {
  return getActiveSession(states, userId, platform).id;
}

export function createSession(
  states: Map<string, PlatformState>, userId: string, platform: string, type: SessionType, maxSessions: number,
): ManagedSession | string {
  const state = getOrCreateState(states, userId, platform);
  const alive = state.sessions.filter(s => s.status !== "ended");
  if (alive.length >= maxSessions) return `Max sessions reached (${maxSessions}). End or kill a session first.`;
  const session = allocateSession(state, type, true, userId, platform, 0);
  state.activeIndex = session.shortIndex;
  return session;
}

export function createSubSession(
  states: Map<string, PlatformState>, userId: string, platform: string, type: SessionType, maxSessions: number,
): ManagedSession | string {
  const state = getOrCreateState(states, userId, platform);
  const alive = state.sessions.filter(s => s.status !== "ended");
  if (alive.length >= maxSessions) return `Max sessions reached — auto-spawn skipped.`;
  const active = state.sessions.find(s => s.shortIndex === state.activeIndex && s.status !== "ended");
  return allocateSession(state, type, false, userId, platform, 0, active?.id);
}

export function switchSession(states: Map<string, PlatformState>, userId: string, platform: string, index: number): ManagedSession | string {
  const state = getOrCreateState(states, userId, platform);
  const target = state.sessions.find(s => s.shortIndex === index && s.status !== "ended" && s.isTransport);
  if (!target) return `Session #${index} not found or not switchable.`;
  state.activeIndex = target.shortIndex;
  return target;
}

export function endSession(states: Map<string, PlatformState>, userId: string, platform: string, index?: number): ManagedSession | string {
  const state = getOrCreateState(states, userId, platform);
  const targetIdx = index ?? state.activeIndex;
  const target = state.sessions.find(s => s.shortIndex === targetIdx && s.status !== "ended");
  if (!target) return `Session #${targetIdx} not found.`;

  const aliveMains = state.sessions.filter(s => sessionType(s) === "A" && s.status !== "ended");
  if (sessionType(target) === "A" && aliveMains.length <= 1) {
    target.status = "ended";
    pushLog(target, "ended");
    const newMain = allocateSession(state, "A", true, userId, platform, target.chatId);
    state.activeIndex = newMain.shortIndex;
    return target;
  }

  target.status = "ended";
  pushLog(target, "ended");
  if (state.activeIndex === targetIdx) {
    const main = state.sessions.find(s => sessionType(s) === "A" && s.status !== "ended");
    state.activeIndex = main?.shortIndex ?? 1;
  }
  return target;
}

export function killSession(states: Map<string, PlatformState>, userId: string, platform: string, index: number): ManagedSession | string {
  const state = getOrCreateState(states, userId, platform);
  const target = state.sessions.find(s => s.shortIndex === index && s.status !== "ended");
  if (!target) return `Session #${index} not found.`;

  if (state.activeIndex === index) {
    const otherMain = state.sessions.find(s => sessionType(s) === "A" && s.status !== "ended" && s.shortIndex !== index);
    if (otherMain) {
      state.activeIndex = otherMain.shortIndex;
    } else {
      target.status = "ended";
      pushLog(target, "killed");
      const newMain = allocateSession(state, "A", true, userId, platform, target.chatId);
      state.activeIndex = newMain.shortIndex;
      return target;
    }
  } else {
    const aliveMains = state.sessions.filter(s => sessionType(s) === "A" && s.status !== "ended");
    if (sessionType(target) === "A" && aliveMains.length <= 1) {
      target.status = "ended";
      pushLog(target, "killed");
      allocateSession(state, "A", true, userId, platform, target.chatId);
      return target;
    }
  }

  target.status = "ended";
  pushLog(target, "killed");
  return target;
}

export function pauseSession(states: Map<string, PlatformState>, userId: string, platform: string, index?: number): ManagedSession | string {
  const state = getOrCreateState(states, userId, platform);
  const targetIdx = index ?? state.activeIndex;
  const target = state.sessions.find(s => s.shortIndex === targetIdx && s.status !== "ended");
  if (!target) return `Session #${targetIdx} not found.`;
  if (target.status === "paused") return `Session #${targetIdx} is already paused.`;
  target.status = "paused";
  pushLog(target, "paused");
  return target;
}

export function resumeSession(states: Map<string, PlatformState>, userId: string, platform: string, index?: number): ManagedSession | string {
  const state = getOrCreateState(states, userId, platform);
  const targetIdx = index ?? state.activeIndex;
  const target = state.sessions.find(s => s.shortIndex === targetIdx && s.status !== "ended");
  if (!target) return `Session #${targetIdx} not found.`;
  if (target.status !== "paused") return `Session #${targetIdx} is not paused.`;
  target.status = "ready";
  pushLog(target, "resumed");
  return target;
}

export function listSessions(states: Map<string, PlatformState>, userId: string, platform: string): { sessions: ManagedSession[]; activeIndex: number } {
  const state = getOrCreateState(states, userId, platform);
  return { sessions: state.sessions.filter(s => s.status !== "ended"), activeIndex: state.activeIndex };
}

export function listAllSessions(states: Map<string, PlatformState>): ManagedSession[] {
  const all: ManagedSession[] = [];
  for (const state of states.values()) {
    for (const s of state.sessions) if (s.status !== "ended") all.push(s);
  }
  return all;
}

export function getSessionById(states: Map<string, PlatformState>, sessionId: string): ManagedSession | undefined {
  for (const state of states.values()) {
    const found = state.sessions.find(s => s.id === sessionId);
    if (found) return found;
  }
  return undefined;
}

export function formatList(states: Map<string, PlatformState>, userId: string, platform: string): string {
  const { sessions, activeIndex } = listSessions(states, userId, platform);
  if (sessions.length === 0) return "No active sessions.";
  return sessions.map(s => {
    const marker = s.shortIndex === activeIndex ? " *" : "";
    const sub = s.isTransport ? "" : " (sub)";
    const paused = s.status === "paused" ? " ⏸" : "";
    const model = s.model ? ` ${s.model}` : "";
    const time = new Date(sessionCreatedAt(s)).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const idle = Math.round((Date.now() - s.lastActiveAt) / 60000);
    const metrics = s.messageCount ? ` | ${s.messageCount} msgs` : "";
    return `#${s.shortIndex} ${typeLabel(sessionType(s))}${sub}${model} — ${time}${paused}${marker} | idle ${idle}m${metrics}`;
  }).join("\n");
}
