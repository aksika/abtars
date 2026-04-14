import type { AgentSession } from "./subagent-runtime.js";
import type { SubagentRuntime } from "./subagent-runtime.js";
import { logInfo } from "./logger.js";

/**
 * Manages the coding agent lifecycle.
 * Tracks which sessions are in coding mode and lazily creates/destroys
 * the agent session via SubagentRuntime.
 */
export class CodingMode {
  private readonly sessions = new Set<string>();
  private agentSession: AgentSession | null = null;
  private readonly runtime: SubagentRuntime;

  constructor(runtime: SubagentRuntime) {
    this.runtime = runtime;
  }

  has(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  getSession(): AgentSession | null {
    return this.agentSession;
  }

  async start(sessionKey: string): Promise<void> {
    if (!this.agentSession) {
      this.agentSession = await this.runtime.session("coding");
    }
    this.sessions.add(sessionKey);
    await this.agentSession.sendPrompt(sessionKey, [
      "[SYSTEM] You are the coding agent for AgentBridge.",
      `Project root: ${process.env["WORKING_DIR"] || process.cwd()}`,
      "Read docs/specs/system.asbuilt.md and docs/specs/memory.asbuilt.md before making changes.",
      "Always create a new git branch before coding. Switch back to main when done.",
    ].join("\n"));
    logInfo("coding-mode", `Activated for ${sessionKey}`);
  }

  async stop(sessionKey: string): Promise<void> {
    this.sessions.delete(sessionKey);
    if (this.agentSession && this.sessions.size === 0) {
      try { await this.agentSession.sendPrompt(sessionKey, "Run: git checkout main"); } catch { /* ok */ }
      await this.agentSession.destroy();
      this.agentSession = null;
    }
    logInfo("coding-mode", `Deactivated for ${sessionKey}`);
  }
}
