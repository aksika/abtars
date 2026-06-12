/**
 * session-manager.ts — Per-user per-platform session state (#510).
 *
 * Two layers:
 *   Transport session: actual ConversationSession (context switch on manual /session commands)
 *   Storage session ID: tag written to abmind (changes for both manual and auto-spawn)
 */

import type { Platform } from "../types/platform.js";
import type { SubagentRuntime, AgentSession, AgentName } from "./subagent-runtime.js";

export type SessionType = "A" | "B" | "C" | "T" | "P" | "S" | "O" | "W" | "D" | "H";

export interface ManagedSession {
  id: string;                    // "1749563282_A_01" — encodes type + createdAt + index
  userId: string;
  platform: string;
  chatId: number;
  threadId?: number | string;    // TG topic, Discord thread

  // Transport
  transport?: import("./transport/kiro-transport.js").IKiroTransport;
  delivery: "streaming" | "simple";
  model?: string;                // "claude-opus-4.6"
  provider?: string;             // "kiro", "openrouter"
  pid?: number;                  // OS process ID of CLI transport

  // Lifecycle
  status: "creating" | "ready" | "paused" | "ended";
  idleTimeoutMs: number;
  lastActiveAt: number;
  motherId?: string;             // parent session (Orc-spawned)
  name?: string;                 // human label, alphanumeric max 20

  // Context
  workingDir?: string;           // CWD for tool execution
  contextPercent?: number;       // last known ctx%

  // Metrics
  messageCount: number;
  tokenCount: number;
  toolCallCount: number;

  // Legacy compat (derived — kept for existing code that reads them)
  shortIndex: number;
  isTransport: boolean;
  agentSession?: import("./subagent-runtime.js").AgentSession;
}

/** Derive type from session ID. */
export function sessionType(session: ManagedSession): SessionType {
  return (session.id.split("_")[1] ?? "A") as SessionType;
}

/** Derive createdAt from session ID. */
export function sessionCreatedAt(session: ManagedSession): number {
  return parseInt(session.id.split("_")[0], 10) * 1000;
}

interface PlatformState {
  sessions: ManagedSession[];
  activeIndex: number;  // shortIndex of active transport session
  nextIndex: number;    // monotonic counter
}

const TYPE_LABELS: Record<SessionType, string> = { A: "Main", B: "Browse", C: "Code", T: "Task", P: "Peer", S: "System", O: "Orc", W: "Worker", D: "Dreamy", H: "Healer" };
const TYPE_AGENT: Partial<Record<SessionType, AgentName>> = { A: "professor", C: "coding", B: "browsie", D: "dreamy", O: "professor", T: "professor", W: "browsie", H: "coding" };

export function typeLabel(t: SessionType): string { return TYPE_LABELS[t]; }

export function parseSessionType(input: string): SessionType | null {
  switch (input.toLowerCase()) {
    case "browse": return "B";
    case "code": return "C";
    case "task": return "T";
    default: return null;
  }
}

export class SessionManager {
  private readonly states = new Map<string, PlatformState>(); // key = "userId:platform"
  private readonly maxSessions: number;
  private runtime: SubagentRuntime | null = null;

  constructor(maxSessions = 10) {
    this.maxSessions = maxSessions;
  }

  /** Set runtime (called after boot phase creates it). */
  setRuntime(runtime: SubagentRuntime): void {
    this.runtime = runtime;
  }

  private stateKey(userId: string, platform: Platform): string {
    return `${userId}:${platform}`;
  }

  private getOrCreateState(userId: string, platform: Platform): PlatformState {
    const key = this.stateKey(userId, platform);
    let state = this.states.get(key);
    if (!state) {
      state = { sessions: [], activeIndex: 1, nextIndex: 1 };
      this.states.set(key, state);
      // Create initial main session
      const main = this.allocateSession(state, "A", true, userId, platform, undefined);
      state.activeIndex = main.shortIndex;
    }
    return state;
  }

  private allocateSession(state: PlatformState, type: SessionType, isTransport: boolean, userId: string, platform: string, motherId?: string): ManagedSession {
    const idx = state.nextIndex++;
    const ts = Math.floor(Date.now() / 1000);
    const session: ManagedSession = {
      id: `${ts}_${type}_${String(idx).padStart(2, "0")}`,
      userId,
      platform,
      chatId: 0, // set by caller or resolveSession
      delivery: "simple",
      status: "ready",  // metadata only until Spin attaches transport
      idleTimeoutMs: 7200000, // default 2h, overridden by Spin for master
      lastActiveAt: Date.now(),
      motherId,
      messageCount: 0,
      tokenCount: 0,
      toolCallCount: 0,
      // Legacy compat
      shortIndex: idx,
      isTransport,
    };
    state.sessions.push(session);
    return session;
  }

  /** Get or create the initial main session. Returns its session ID. */
  getActiveSessionId(userId: string, platform: Platform): string {
    const state = this.getOrCreateState(userId, platform);
    const active = state.sessions.find(s => s.shortIndex === state.activeIndex && s.status !== "ended");
    return active?.id ?? state.sessions[0]!.id;
  }

  /** Get the active session entry. */
  getActiveSession(userId: string, platform: Platform): ManagedSession {
    const state = this.getOrCreateState(userId, platform);
    return state.sessions.find(s => s.shortIndex === state.activeIndex && s.status !== "ended") ?? state.sessions[0]!;
  }

  /** Initialize agent session for non-Main types. Returns the AgentSession or null. */
  async initAgentSession(session: ManagedSession): Promise<AgentSession | null> {
    const agentName = TYPE_AGENT[sessionType(session)];
    if (!agentName || !this.runtime) return null;
    if (session.agentSession) return session.agentSession;
    session.agentSession = await this.runtime.session(agentName);
    return session.agentSession;
  }

  /** Create a new transport session. Returns the session or error string. */
  createSession(userId: string, platform: Platform, type: SessionType): ManagedSession | string {
    const state = this.getOrCreateState(userId, platform);
    const alive = state.sessions.filter(s => s.status !== "ended");
    if (alive.length >= this.maxSessions) {
      return `Max sessions reached (${this.maxSessions}). End or kill a session first.`;
    }
    const session = this.allocateSession(state, type, true, userId, platform);
    state.activeIndex = session.shortIndex;
    return session;
  }

  /** Create a sub-session ID for auto-spawn (storage tag only, no transport switch). */
  createSubSession(userId: string, platform: Platform, type: SessionType): ManagedSession | string {
    const state = this.getOrCreateState(userId, platform);
    const alive = state.sessions.filter(s => s.status !== "ended");
    if (alive.length >= this.maxSessions) {
      return `Max sessions reached — auto-spawn skipped.`;
    }
    const active = state.sessions.find(s => s.shortIndex === state.activeIndex && s.status !== "ended");
    const result = this.allocateSession(state, type, false, userId, platform, active?.id);
    return result;
  }

  /** Switch active transport session. Returns session or error. */
  switchSession(userId: string, platform: Platform, index: number): ManagedSession | string {
    const state = this.getOrCreateState(userId, platform);
    const target = state.sessions.find(s => s.shortIndex === index && s.status !== "ended" && s.isTransport);
    if (!target) return `Session #${index} not found or not switchable.`;
    state.activeIndex = target.shortIndex;
    return target;
  }

  /** Gracefully end a session (keeps messages). Returns ended session or error. */
  endSession(userId: string, platform: Platform, index?: number): ManagedSession | string {
    const state = this.getOrCreateState(userId, platform);
    const targetIdx = index ?? state.activeIndex;
    const target = state.sessions.find(s => s.shortIndex === targetIdx && s.status !== "ended");
    if (!target) return `Session #${targetIdx} not found.`;

    // If ending the last Main session, create a replacement
    const aliveMains = state.sessions.filter(s => sessionType(s) === "A" && s.status !== "ended");
    if (sessionType(target) === "A" && aliveMains.length <= 1) {
      target.status = "ended";
      const newMain = this.allocateSession(state, "A", true, userId, platform);
      state.activeIndex = newMain.shortIndex;
      return target;
    }

    target.status = "ended";
    // If ending active, switch to main
    if (state.activeIndex === targetIdx) {
      const main = state.sessions.find(s => sessionType(s) === "A" && s.status !== "ended");
      state.activeIndex = main?.shortIndex ?? 1;
    }
    return target;
  }

  /** Kill a session (wipe messages). Returns killed session or error. */
  killSession(userId: string, platform: Platform, index: number): ManagedSession | string {
    const state = this.getOrCreateState(userId, platform);
    const target = state.sessions.find(s => s.shortIndex === index && s.status !== "ended");
    if (!target) return `Session #${index} not found.`;

    // If killing active, switch to main first
    if (state.activeIndex === index) {
      const otherMain = state.sessions.find(s => sessionType(s) === "A" && s.status !== "ended" && s.shortIndex !== index);
      if (otherMain) {
        state.activeIndex = otherMain.shortIndex;
      } else {
        target.status = "ended";
        const newMain = this.allocateSession(state, "A", true, userId, platform);
        state.activeIndex = newMain.shortIndex;
        return target;
      }
    } else {
      const aliveMains = state.sessions.filter(s => sessionType(s) === "A" && s.status !== "ended");
      if (sessionType(target) === "A" && aliveMains.length <= 1) {
        target.status = "ended";
        this.allocateSession(state, "A", true, userId, platform);
        return target;
      }
    }

    target.status = "ended";
    return target;
  }

  /** List all sessions for a user+platform. */
  listSessions(userId: string, platform: Platform): { sessions: ManagedSession[]; activeIndex: number } {
    const state = this.getOrCreateState(userId, platform);
    return { sessions: state.sessions.filter(s => s.status !== "ended"), activeIndex: state.activeIndex };
  }

  /** Find a session by ID across all platforms. */
  getSessionById(sessionId: string): ManagedSession | undefined {
    for (const state of this.states.values()) {
      const found = state.sessions.find(s => s.id === sessionId);
      if (found) return found;
    }
    return undefined;
  }

  /** Pause a session (cooperative interrupt — agent loop stops between tool calls). */
  pauseSession(userId: string, platform: Platform, index?: number): ManagedSession | string {
    const state = this.getOrCreateState(userId, platform);
    const targetIdx = index ?? state.activeIndex;
    const target = state.sessions.find(s => s.shortIndex === targetIdx && s.status !== "ended");
    if (!target) return `Session #${targetIdx} not found.`;
    if (target.status === "paused") return `Session #${targetIdx} is already paused.`;
    target.status = "paused";
    return target;
  }

  /** Resume a paused session. */
  resumeSession(userId: string, platform: Platform, index?: number): ManagedSession | string {
    const state = this.getOrCreateState(userId, platform);
    const targetIdx = index ?? state.activeIndex;
    const target = state.sessions.find(s => s.shortIndex === targetIdx && s.status !== "ended");
    if (!target) return `Session #${targetIdx} not found.`;
    if (target.status !== "paused") return `Session #${targetIdx} is not paused.`;
    target.status = "ready";
    return target;
  }

  /** End auto-spawn sessions that have been inactive. */
  expireAutoSessions(timeoutMs: number): ManagedSession[] {
    const expired: ManagedSession[] = [];
    const cutoff = Date.now() - timeoutMs;
    for (const state of this.states.values()) {
      for (const s of state.sessions) {
        if (s.status !== "ended" && !s.isTransport && s.lastActiveAt < cutoff) {
          s.status = "ended";
          expired.push(s);
        }
      }
    }
    return expired;
  }

  /** Clear all sessions for a platform (transport destruction). */
  clearPlatform(userId: string, platform: Platform): void {
    this.states.delete(this.stateKey(userId, platform));
  }

  /** List all sessions across all users/platforms (for heartbeat expiry). */
  listAllSessions(): ManagedSession[] {
    const all: ManagedSession[] = [];
    for (const state of this.states.values()) {
      for (const s of state.sessions) {
        if (s.status !== "ended") all.push(s);
      }
    }
    return all;
  }

  /** Clear everything (bridge restart). */
  clearAll(): void {
    this.states.clear();
  }

  /** Format session list for display. */
  formatList(userId: string, platform: Platform): string {
    const { sessions, activeIndex } = this.listSessions(userId, platform);
    if (sessions.length === 0) return "No active sessions.";
    const lines = sessions.map(s => {
      const marker = s.shortIndex === activeIndex ? " *" : "";
      const transport = s.isTransport ? "" : " (sub)";
      const paused = s.status === "paused" ? " ⏸" : "";
      const mother = s.motherId ? ` ← #${this.getSessionById(s.motherId)?.shortIndex ?? "?"}` : "";
      const time = new Date(sessionCreatedAt(s)).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      return `#${s.shortIndex} ${typeLabel(sessionType(s))}${transport}${mother} — ${time}${paused}${marker}`;
    });
    return lines.join("\n");
  }
}
