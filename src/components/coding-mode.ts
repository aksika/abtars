import { AcpTransport } from "./acp-transport.js";
import { logInfo } from "./logger.js";

/**
 * Manages the coding agent transport lifecycle.
 * Tracks which sessions are in coding mode and lazily creates/destroys
 * the ACP transport for the coding agent.
 */
export class CodingMode {
  private readonly sessions = new Set<string>();
  private transport: AcpTransport | null = null;
  private readonly cliPath: string;
  private readonly workingDir: string;
  private readonly model: string;

  constructor(cliPath: string, workingDir: string, model: string) {
    this.cliPath = cliPath;
    this.workingDir = workingDir;
    this.model = model;
  }

  has(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  getTransport(): AcpTransport | null {
    return this.transport;
  }

  async start(sessionKey: string): Promise<void> {
    if (!this.transport) {
      this.transport = new AcpTransport(this.cliPath, this.workingDir, {
        agent: "coding-agent",
        model: this.model,
      });
      await this.transport.initialize();
    }
    this.sessions.add(sessionKey);
    await this.transport.sendPrompt(sessionKey, [
      "[SYSTEM] You are the coding agent for AgentBridge.",
      `Project root: ${this.workingDir}`,
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
