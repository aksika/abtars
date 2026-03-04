import type { SessionState } from "../types/index.js";
import type { AcpClient } from "./acp-client.js";
import type { MemoryManager } from "./memory-manager.js";

/**
 * Maps platform-prefixed session keys (e.g. "telegram:123", "discord:456")
 * to ACP sessions. Handles creation, reset, and crash recovery of sessions.
 */
export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private readonly acpClient: AcpClient;
  private readonly workingDir: string;
  private readonly memory: MemoryManager | null;

  constructor(acpClient: AcpClient, workingDir: string, memory?: MemoryManager) {
    this.acpClient = acpClient;
    this.workingDir = workingDir;
    this.memory = memory ?? null;
  }

  /** Get existing session or create a new one for this session key. */
  async getOrCreateSession(sessionKey: string): Promise<SessionState> {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      existing.lastActivityAt = Date.now();
      this.memory?.touchSession(sessionKey, existing.acpSessionId);
      return existing;
    }
    return this.createSession(sessionKey);
  }

  /** Destroy current session and create a fresh one. */
  async resetSession(sessionKey: string): Promise<SessionState> {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      this.memory?.deactivateSession(sessionKey, existing.acpSessionId);
      try {
        await this.acpClient.cancelSession(existing.acpSessionId);
      } catch {
        // Session may already be dead — that's fine
      }
    }
    this.sessions.delete(sessionKey);
    return this.createSession(sessionKey);
  }

  /** Alias for resetSession — handles /new command. */
  async handleNewCommand(sessionKey: string): Promise<SessionState> {
    return this.resetSession(sessionKey);
  }

  /** Recreate session after a crash. Returns a notification message. */
  async handleCrash(sessionKey: string): Promise<string> {
    this.sessions.delete(sessionKey);
    try {
      await this.createSession(sessionKey);
      return "⚠️ Session was interrupted. A new session has been created automatically.";
    } catch {
      return "❌ Failed to recreate session after crash. Please try again.";
    }
  }

  /** Check if a session is currently processing a prompt. */
  isSessionBusy(sessionKey: string): boolean {
    return this.sessions.get(sessionKey)?.isProcessing ?? false;
  }

  /** Mark session as processing or idle. */
  setProcessing(sessionKey: string, processing: boolean): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.isProcessing = processing;
      session.lastActivityAt = Date.now();
    }
  }

  /** Get session state for a session key (if exists). */
  getSession(sessionKey: string): SessionState | undefined {
    return this.sessions.get(sessionKey);
  }

  /** Get all active session keys. */
  getActiveSessionKeys(): string[] {
    return [...this.sessions.keys()];
  }

  /** Restore sessions from memory storage. Returns the number of sessions restored. */
  async restoreFromMemory(): Promise<number> {
    if (!this.memory) return 0;

    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    const stored = this.memory.restoreSessions(TWENTY_FOUR_HOURS);
    let restored = 0;

    for (const s of stored) {
      if (this.sessions.has(s.channelKey)) continue;

      try {
        const acpSessionId = await this.acpClient.createSession(this.workingDir);
        const session: SessionState = {
          channelKey: s.channelKey,
          acpSessionId,
          isProcessing: false,
          pendingRequestId: null,
          createdAt: s.createdAt,
          lastActivityAt: s.lastActivityAt,
        };
        this.sessions.set(s.channelKey, session);
        this.memory.persistSession(session);
        restored++;
      } catch {
        // Log but don't throw — restoration is best-effort
      }
    }

    return restored;
  }

  private async createSession(sessionKey: string): Promise<SessionState> {
    const acpSessionId = await this.acpClient.createSession(this.workingDir);
    const now = Date.now();
    const session: SessionState = {
      channelKey: sessionKey,
      acpSessionId,
      isProcessing: false,
      pendingRequestId: null,
      createdAt: now,
      lastActivityAt: now,
    };
    this.sessions.set(sessionKey, session);
    this.memory?.persistSession(session);
    return session;
  }
}
