/**
 * session-manager.ts — Per-user per-platform session state (#510).
 *
 * Two layers:
 *   Transport session: actual ConversationSession (context switch on manual /session commands)
 *   Storage session ID: tag written to abmind (changes for both manual and auto-spawn)
 */

import type { Platform } from "../types/platform.js";
import type { SubagentRuntime, AgentSession, AgentName } from "./subagent-runtime.js";

export type SessionType = "A" | "B" | "C" | "T";

export interface ManagedSession {
  id: string;           // "1747563282_A_01"
  shortIndex: number;   // 1, 2, 3...
  type: SessionType;    // A=Main, B=Browse, C=Code, T=Task
  createdAt: number;    // epoch ms
  isTransport: boolean; // true = has own ConversationSession, false = storage tag only
  ended: boolean;       // gracefully ended (messages kept)
  agentSession?: import("./subagent-runtime.js").AgentSession; // sub-transport for C/B/T
}

interface PlatformState {
  sessions: ManagedSession[];
  activeIndex: number;  // shortIndex of active transport session
  nextIndex: number;    // monotonic counter
}

const TYPE_LABELS: Record<SessionType, string> = { A: "Main", B: "Browse", C: "Code", T: "Task" };
const TYPE_AGENT: Partial<Record<SessionType, AgentName>> = { C: "coding", B: "browsie" };

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
      const main = this.allocateSession(state, "A", true);
      state.activeIndex = main.shortIndex;
    }
    return state;
  }

  private allocateSession(state: PlatformState, type: SessionType, isTransport: boolean): ManagedSession {
    const idx = state.nextIndex++;
    const ts = Math.floor(Date.now() / 1000);
    const session: ManagedSession = {
      id: `${ts}_${type}_${String(idx).padStart(2, "0")}`,
      shortIndex: idx,
      type,
      createdAt: Date.now(),
      isTransport,
      ended: false,
    };
    state.sessions.push(session);
    return session;
  }

  /** Get or create the initial main session. Returns its session ID. */
  getActiveSessionId(userId: string, platform: Platform): string {
    const state = this.getOrCreateState(userId, platform);
    const active = state.sessions.find(s => s.shortIndex === state.activeIndex && !s.ended);
    return active?.id ?? state.sessions[0]!.id;
  }

  /** Get the active session entry. */
  getActiveSession(userId: string, platform: Platform): ManagedSession {
    const state = this.getOrCreateState(userId, platform);
    return state.sessions.find(s => s.shortIndex === state.activeIndex && !s.ended) ?? state.sessions[0]!;
  }

  /** Initialize agent session for non-Main types. Returns the AgentSession or null. */
  async initAgentSession(session: ManagedSession): Promise<AgentSession | null> {
    const agentName = TYPE_AGENT[session.type];
    if (!agentName || !this.runtime) return null;
    if (session.agentSession) return session.agentSession;
    session.agentSession = await this.runtime.session(agentName);
    return session.agentSession;
  }

  /** Create a new transport session. Returns the session or error string. */
  createSession(userId: string, platform: Platform, type: SessionType): ManagedSession | string {
    const state = this.getOrCreateState(userId, platform);
    const alive = state.sessions.filter(s => !s.ended);
    if (alive.length >= this.maxSessions) {
      return `Max sessions reached (${this.maxSessions}). End or kill a session first.`;
    }
    const session = this.allocateSession(state, type, true);
    state.activeIndex = session.shortIndex;
    return session;
  }

  /** Create a sub-session ID for auto-spawn (storage tag only, no transport switch). */
  createSubSession(userId: string, platform: Platform, type: SessionType): ManagedSession | string {
    const state = this.getOrCreateState(userId, platform);
    const alive = state.sessions.filter(s => !s.ended);
    if (alive.length >= this.maxSessions) {
      return `Max sessions reached — auto-spawn skipped.`;
    }
    return this.allocateSession(state, type, false);
  }

  /** Switch active transport session. Returns session or error. */
  switchSession(userId: string, platform: Platform, index: number): ManagedSession | string {
    const state = this.getOrCreateState(userId, platform);
    const target = state.sessions.find(s => s.shortIndex === index && !s.ended && s.isTransport);
    if (!target) return `Session #${index} not found or not switchable.`;
    state.activeIndex = target.shortIndex;
    return target;
  }

  /** Gracefully end a session (keeps messages). Returns ended session or error. */
  endSession(userId: string, platform: Platform, index?: number): ManagedSession | string {
    const state = this.getOrCreateState(userId, platform);
    const targetIdx = index ?? state.activeIndex;
    const target = state.sessions.find(s => s.shortIndex === targetIdx && !s.ended);
    if (!target) return `Session #${targetIdx} not found.`;

    // If ending the last Main session, create a replacement
    const aliveMains = state.sessions.filter(s => s.type === "A" && !s.ended);
    if (target.type === "A" && aliveMains.length <= 1) {
      target.ended = true;
      const newMain = this.allocateSession(state, "A", true);
      state.activeIndex = newMain.shortIndex;
      return target;
    }

    target.ended = true;
    // If ending active, switch to main
    if (state.activeIndex === targetIdx) {
      const main = state.sessions.find(s => s.type === "A" && !s.ended);
      state.activeIndex = main?.shortIndex ?? 1;
    }
    return target;
  }

  /** Kill a session (wipe messages). Returns killed session or error. */
  killSession(userId: string, platform: Platform, index: number): ManagedSession | string {
    const state = this.getOrCreateState(userId, platform);
    const target = state.sessions.find(s => s.shortIndex === index && !s.ended);
    if (!target) return `Session #${index} not found.`;

    // If killing active, switch to main first
    if (state.activeIndex === index) {
      const otherMain = state.sessions.find(s => s.type === "A" && !s.ended && s.shortIndex !== index);
      if (otherMain) {
        state.activeIndex = otherMain.shortIndex;
      } else {
        // Last Main — kill it but auto-spawn replacement
        target.ended = true;
        const newMain = this.allocateSession(state, "A", true);
        state.activeIndex = newMain.shortIndex;
        return target;
      }
    } else {
      // Killing non-active last Main — still auto-spawn replacement
      const aliveMains = state.sessions.filter(s => s.type === "A" && !s.ended);
      if (target.type === "A" && aliveMains.length <= 1) {
        target.ended = true;
        this.allocateSession(state, "A", true);
        return target;
      }
    }

    target.ended = true;
    return target;
  }

  /** List all sessions for a user+platform. */
  listSessions(userId: string, platform: Platform): { sessions: ManagedSession[]; activeIndex: number } {
    const state = this.getOrCreateState(userId, platform);
    return { sessions: state.sessions.filter(s => !s.ended), activeIndex: state.activeIndex };
  }

  /** End auto-spawn sessions that have been inactive. */
  expireAutoSessions(timeoutMs: number): ManagedSession[] {
    const expired: ManagedSession[] = [];
    const cutoff = Date.now() - timeoutMs;
    for (const state of this.states.values()) {
      for (const s of state.sessions) {
        if (!s.ended && !s.isTransport && s.createdAt < cutoff) {
          s.ended = true;
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
      const time = new Date(s.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      return `#${s.shortIndex} ${typeLabel(s.type)}${transport} — ${time}${marker}`;
    });
    return lines.join("\n");
  }
}
