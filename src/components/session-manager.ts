/**
 * session-manager.ts — Per-user per-platform session state (#510).
 *
 * Two layers:
 *   Transport session: actual ConversationSession (context switch on manual /session commands)
 *   Storage session ID: tag written to abmind (changes for both manual and auto-spawn)
 */

import type { Platform } from "../types/platform.js";
import type { SubagentRuntime, AgentSession, AgentName } from "./subagent-runtime.js";
import { writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../paths.js";
import { logInfo, logWarn } from "./logger.js";

export type SessionType = "A" | "B" | "C" | "T" | "P" | "S" | "O" | "W" | "D" | "H";

export interface ManagedSession {
  id: string;           // "1747563282_A_01"
  shortIndex: number;   // 1, 2, 3...
  type: SessionType;    // A=Main, B=Browse, C=Code, T=Task
  createdAt: number;    // epoch ms
  isTransport: boolean; // true = has own ConversationSession, false = storage tag only
  ended: boolean;       // gracefully ended (messages kept)
  paused: boolean;      // cooperative interrupt — agent loop stops between tool calls
  motherId?: string;    // session ID of the session that spawned this one (lineage)
  agentSession?: import("./subagent-runtime.js").AgentSession; // sub-transport for C/B/T
}

interface PlatformState {
  sessions: ManagedSession[];
  activeIndex: number;  // shortIndex of active transport session
  nextIndex: number;    // monotonic counter
}

const TYPE_LABELS: Record<SessionType, string> = { A: "Main", B: "Browse", C: "Code", T: "Task", P: "Peer", S: "System", O: "Orc", W: "Worker", D: "Dreamy", H: "Healer" };
const TYPE_AGENT: Partial<Record<SessionType, AgentName>> = { C: "coding", B: "browsie", P: "coding", S: "coding", T: "task", O: "professor", W: "task" };

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

  private allocateSession(state: PlatformState, type: SessionType, isTransport: boolean, motherId?: string): ManagedSession {
    const idx = state.nextIndex++;
    const ts = Math.floor(Date.now() / 1000);
    const session: ManagedSession = {
      id: `${ts}_${type}_${String(idx).padStart(2, "0")}`,
      shortIndex: idx,
      type,
      createdAt: Date.now(),
      isTransport,
      ended: false,
      paused: false,
      motherId,
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
    this.scheduleSave();
    return session;
  }

  /** Create a sub-session ID for auto-spawn (storage tag only, no transport switch). */
  createSubSession(userId: string, platform: Platform, type: SessionType): ManagedSession | string {
    const state = this.getOrCreateState(userId, platform);
    const alive = state.sessions.filter(s => !s.ended);
    if (alive.length >= this.maxSessions) {
      return `Max sessions reached — auto-spawn skipped.`;
    }
    const active = state.sessions.find(s => s.shortIndex === state.activeIndex && !s.ended);
    const result = this.allocateSession(state, type, false, active?.id);
    this.scheduleSave();
    return result;
  }

  /** Switch active transport session. Returns session or error. */
  switchSession(userId: string, platform: Platform, index: number): ManagedSession | string {
    const state = this.getOrCreateState(userId, platform);
    const target = state.sessions.find(s => s.shortIndex === index && !s.ended && s.isTransport);
    if (!target) return `Session #${index} not found or not switchable.`;
    state.activeIndex = target.shortIndex;
    this.scheduleSave();
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
      this.scheduleSave();
      return target;
    }

    target.ended = true;
    // If ending active, switch to main
    if (state.activeIndex === targetIdx) {
      const main = state.sessions.find(s => s.type === "A" && !s.ended);
      state.activeIndex = main?.shortIndex ?? 1;
    }
    this.scheduleSave();
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
        target.ended = true;
        const newMain = this.allocateSession(state, "A", true);
        state.activeIndex = newMain.shortIndex;
        this.scheduleSave();
        return target;
      }
    } else {
      const aliveMains = state.sessions.filter(s => s.type === "A" && !s.ended);
      if (target.type === "A" && aliveMains.length <= 1) {
        target.ended = true;
        this.allocateSession(state, "A", true);
        this.scheduleSave();
        return target;
      }
    }

    target.ended = true;
    this.scheduleSave();
    return target;
  }

  /** List all sessions for a user+platform. */
  listSessions(userId: string, platform: Platform): { sessions: ManagedSession[]; activeIndex: number } {
    const state = this.getOrCreateState(userId, platform);
    return { sessions: state.sessions.filter(s => !s.ended), activeIndex: state.activeIndex };
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
    const target = state.sessions.find(s => s.shortIndex === targetIdx && !s.ended);
    if (!target) return `Session #${targetIdx} not found.`;
    if (target.paused) return `Session #${targetIdx} is already paused.`;
    target.paused = true;
    this.scheduleSave();
    return target;
  }

  /** Resume a paused session. */
  resumeSession(userId: string, platform: Platform, index?: number): ManagedSession | string {
    const state = this.getOrCreateState(userId, platform);
    const targetIdx = index ?? state.activeIndex;
    const target = state.sessions.find(s => s.shortIndex === targetIdx && !s.ended);
    if (!target) return `Session #${targetIdx} not found.`;
    if (!target.paused) return `Session #${targetIdx} is not paused.`;
    target.paused = false;
    this.scheduleSave();
    return target;
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
    this.scheduleSave();
  }

  /** Clear everything (bridge restart). */
  clearAll(): void {
    this.states.clear();
  }

  // ── Persistence (#540) ──────────────────────────────────────────────────

  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleSave(): void {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.persist();
    }, 2000);
    this._saveTimer.unref();
  }

  /** Write session state to ~/.abtars/sessions.json (atomic). */
  persist(): void {
    const data: Record<string, { sessions: Array<Omit<ManagedSession, "agentSession">>; activeIndex: number; nextIndex: number }> = {};
    for (const [key, state] of this.states) {
      data[key] = {
        sessions: state.sessions.map(({ agentSession: _, ...rest }) => rest),
        activeIndex: state.activeIndex,
        nextIndex: state.nextIndex,
      };
    }
    const p = join(abtarsHome(), "sessions.json");
    const tmp = p + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify(data), "utf-8");
      renameSync(tmp, p);
    } catch { /* best effort */ }
  }

  /** Restore session state from disk. Call at boot before pipeline starts. */
  restore(): void {
    const p = join(abtarsHome(), "sessions.json");
    if (!existsSync(p)) return;
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8"));
      const now = Date.now();
      const ONE_HOUR = 3600_000;
      const SEVEN_DAYS = 7 * 24 * ONE_HOUR;

      for (const [key, state] of Object.entries(raw) as [string, any][]) {
        if (!state?.sessions || !Array.isArray(state.sessions)) continue;
        const pruned: ManagedSession[] = state.sessions.filter((s: any) => {
          const age = now - (s.createdAt ?? 0);
          if (s.ended && age > ONE_HOUR) return false;
          if (!s.ended && age > SEVEN_DAYS) return false;
          return true;
        });
        if (pruned.length === 0) continue;
        const activeIdx = state.activeIndex ?? 1;
        const hasActive = pruned.some(s => s.shortIndex === activeIdx && !s.ended);
        const restoredState: PlatformState = {
          sessions: pruned,
          activeIndex: hasActive ? activeIdx : (pruned.find(s => !s.ended)?.shortIndex ?? 1),
          nextIndex: state.nextIndex ?? pruned.length + 1,
        };
        // Ensure at least one Main session exists
        if (!pruned.some(s => s.type === "A" && !s.ended)) {
          const main = this.allocateSession(restoredState, "A", true);
          restoredState.activeIndex = main.shortIndex;
        }
        this.states.set(key, restoredState);
      }
      const total = [...this.states.values()].reduce((n, s) => n + s.sessions.length, 0);
      logInfo("session-mgr", `Restored ${total} sessions from disk`);
    } catch (err) {
      logWarn("session-mgr", `Failed to restore sessions.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Format session list for display. */
  formatList(userId: string, platform: Platform): string {
    const { sessions, activeIndex } = this.listSessions(userId, platform);
    if (sessions.length === 0) return "No active sessions.";
    const lines = sessions.map(s => {
      const marker = s.shortIndex === activeIndex ? " *" : "";
      const transport = s.isTransport ? "" : " (sub)";
      const paused = s.paused ? " ⏸" : "";
      const mother = s.motherId ? ` ← #${this.getSessionById(s.motherId)?.shortIndex ?? "?"}` : "";
      const time = new Date(s.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      return `#${s.shortIndex} ${typeLabel(s.type)}${transport}${mother} — ${time}${paused}${marker}`;
    });
    return lines.join("\n");
  }
}
