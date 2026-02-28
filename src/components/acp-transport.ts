import type { IKiroTransport } from "./kiro-transport.js";
import { AcpClient } from "./acp-client.js";
import { ResponseFormatter } from "./response-formatter.js";
import type { AcpNotification } from "../types/index.js";

/**
 * Wraps the AcpClient to implement the IKiroTransport interface.
 * Manages session mapping and response collection internally.
 */
export class AcpTransport implements IKiroTransport {
  private readonly acpClient: AcpClient;
  private readonly formatter: ResponseFormatter;
  private readonly workingDir: string;
  private sessions = new Map<string, string>(); // sessionKey → acpSessionId

  constructor(cliPath: string, workingDir: string) {
    this.acpClient = new AcpClient(cliPath, workingDir);
    this.formatter = new ResponseFormatter();
    this.workingDir = workingDir;
  }

  async initialize(): Promise<void> {
    this.acpClient.spawn();
    await this.acpClient.initialize();

    // Wire up notification collection
    this.acpClient.on("notification", (notification: AcpNotification) => {
      const params = notification.params;
      const sessionId = params["sessionId"] as string | undefined;

      if (notification.method === "session/update" && sessionId) {
        const updateType = params["type"] as string;
        if (updateType === "agent_message_chunk") {
          this.formatter.collectChunk(sessionId, params["content"] as string);
        }
      }
    });
  }

  get isReady(): boolean {
    return this.acpClient.isReady;
  }

  async sendPrompt(sessionKey: string, message: string): Promise<string> {
    const sessionId = await this.getOrCreateSession(sessionKey);
    await this.acpClient.sendPrompt(sessionId, message);

    const chunks = this.formatter.flush(sessionId);
    return chunks.join("\n") || "(no response)";
  }

  async resetSession(sessionKey: string): Promise<void> {
    const sessionId = this.sessions.get(sessionKey);
    if (sessionId) {
      try {
        await this.acpClient.cancelSession(sessionId);
      } catch {
        // Session may already be dead
      }
    }
    this.sessions.delete(sessionKey);
  }

  async sendInterrupt(): Promise<void> {
    // ACP doesn't have a terminal — no-op
  }

  destroy(): void {
    this.acpClient.kill();
  }

  /** Get the AcpClient for advanced wiring (permissions, crash events). */
  getAcpClient(): AcpClient {
    return this.acpClient;
  }

  private async getOrCreateSession(sessionKey: string): Promise<string> {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    const sessionId = await this.acpClient.createSession(this.workingDir);
    this.sessions.set(sessionKey, sessionId);
    return sessionId;
  }
}
