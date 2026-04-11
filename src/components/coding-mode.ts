import type { IKiroTransport } from "./transport/kiro-transport.js";
import { logInfo } from "./logger.js";

/**
 * Manages the coding agent transport lifecycle.
 * Tracks which sessions are in coding mode and lazily creates/destroys
 * the ACP transport for the coding agent.
 */
export class CodingMode {
  private readonly sessions = new Set<string>();
  private transport: IKiroTransport | null = null;

  has(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  getTransport(): IKiroTransport | null {
    return this.transport;
  }

  async start(sessionKey: string): Promise<void> {
    if (!this.transport) {
      const { createSubagentTransport } = await import("./agent-registry.js");
      const { transport } = await createSubagentTransport("coding");
      this.transport = transport;
    }
    this.sessions.add(sessionKey);
    await this.transport.sendPrompt(sessionKey, [
      "[SYSTEM] You are the coding agent for AgentBridge.",
      `Project root: ${process.env["WORKING_DIR"] || process.cwd()}`,
      "Read docs/specs/system.asbuilt.md and docs/specs/memory.asbuilt.md before making changes.",
      "Always create a new git branch before coding. Switch back to main when done.",
    ].join("\n"));
    logInfo("coding-mode", `Activated for ${sessionKey}`);
  }

  async stop(sessionKey: string): Promise<void> {
    this.sessions.delete(sessionKey);
    if (this.transport && this.sessions.size === 0) {
      try { await this.transport.sendPrompt(sessionKey, "Run: git checkout main"); } catch { /* ok */ }
      this.transport.destroy();
      this.transport = null;
    }
    logInfo("coding-mode", `Deactivated for ${sessionKey}`);
  }
}
