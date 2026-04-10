import { createAgentTransport } from "./agent-registry.js";
import { logInfo } from "./logger.js";
import { readBridgeLockTransport } from "./transport/bridge-lock-transport.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";

/**
 * Manages the coding agent transport lifecycle.
 * Tracks which sessions are in coding mode and lazily creates/destroys
 * the ACP transport for the coding agent.
 */
export class CodingMode {
  private readonly sessions = new Set<string>();
  private transport: IKiroTransport | null = null;
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

  getTransport(): IKiroTransport | null {
    return this.transport;
  }

  async start(sessionKey: string): Promise<void> {
    if (!this.transport) {
      // Check if main agent is on Direct API — use that instead of ACP
      const mainTransport = readBridgeLockTransport();
      if (mainTransport?.type === "api") {
        const { DirectApiTransport } = await import("./transport/direct-api-transport.js");
        this.transport = new DirectApiTransport({
          endpoint: mainTransport.endpoint!, apiKey: process.env["API_KEY"],
          model: this.model || mainTransport.model,
          maxContext: parseInt(process.env["API_MAX_CONTEXT"] ?? "131072", 10),
          maxOutput: parseInt(process.env["API_MAX_OUTPUT"] ?? "8192", 10),
          maxTurns: parseInt(process.env["API_MAX_TURNS"] ?? "50", 10),
          fallbacks: this.model && this.model !== mainTransport.model
            ? [{ endpoint: mainTransport.endpoint!, apiKey: process.env["API_KEY"], model: mainTransport.model }]
            : undefined,
        });
      } else {
        this.transport = createAgentTransport("coding", {
          cliPath: this.cliPath,
          workingDir: this.workingDir,
          model: this.model,
        });
      }
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
