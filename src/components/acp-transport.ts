import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { IKiroTransport } from "./kiro-transport.js";
import { logInfo, logDebug, logWarn } from "./logger.js";

const TAG = "acp";

/**
 * ACP transport using @agentclientprotocol/sdk.
 * Spawns kiro-cli acp as a child process and communicates via JSON-RPC over stdio.
 * Based on OpenClaw's client.ts pattern.
 */
export class AcpTransport implements IKiroTransport {
  private readonly cliPath: string;
  private readonly workingDir: string;
  private agent: ChildProcess | null = null;
  private client: ClientSideConnection | null = null;
  private sessions = new Map<string, string>(); // sessionKey → acpSessionId
  private responseChunks = new Map<string, string[]>(); // sessionId → chunks

  /** Optional callback for streaming intermediate responses. */
  onIntermediateResponse?: (text: string) => void;

  /** Optional callback for permission requests. Returns selected optionId or undefined to cancel. */
  onPermissionRequest?: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;

  constructor(cliPath: string, workingDir: string) {
    this.cliPath = cliPath;
    this.workingDir = workingDir;
  }

  async initialize(): Promise<void> {
    this.agent = spawn(this.cliPath, ["acp"], {
      cwd: this.workingDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!this.agent.stdin || !this.agent.stdout) {
      throw new Error("Failed to create ACP stdio pipes");
    }

    this.agent.stderr?.on("data", (chunk: Buffer) => {
      logDebug(TAG, `[stderr] ${chunk.toString().trim()}`);
    });

    this.agent.on("exit", (code, signal) => {
      logWarn(TAG, `kiro-cli exited (code=${code}, signal=${signal})`);
      this.agent = null;
      this.client = null;
    });

    const input = Writable.toWeb(this.agent.stdin);
    const output = Readable.toWeb(this.agent.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);

    this.client = new ClientSideConnection(
      () => ({
        sessionUpdate: async (params: SessionNotification) => {
          this.handleSessionUpdate(params);
        },
        requestPermission: async (params: RequestPermissionRequest) => {
          return this.handlePermission(params);
        },
      }),
      stream,
    );

    logDebug(TAG, "Initializing ACP connection");
    const initResult = await this.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "agentbridge", version: "1.0.0" },
    });
    logInfo(TAG, `ACP initialized (agent: ${initResult.agentInfo?.name ?? "unknown"})`);
  }

  get isReady(): boolean {
    return this.agent !== null && this.client !== null;
  }

  async sendPrompt(sessionKey: string, message: string): Promise<string> {
    if (!this.client) throw new Error("ACP not initialized");

    const sessionId = await this.getOrCreateSession(sessionKey);
    this.responseChunks.set(sessionId, []);

    logDebug(TAG, `Sending prompt to session ${sessionId}: "${message.slice(0, 80)}"`);

    // client.prompt() blocks until the full turn completes.
    // While running, sessionUpdate fires for each agent_message_chunk.
    const result = await this.client.prompt({
      sessionId,
      prompt: [{ type: "text", text: message }],
    });

    logDebug(TAG, `Prompt complete (stopReason: ${result.stopReason})`);

    const chunks = this.responseChunks.get(sessionId) ?? [];
    this.responseChunks.delete(sessionId);
    return chunks.join("") || "(no response)";
  }

  async resetSession(sessionKey: string): Promise<void> {
    const sessionId = this.sessions.get(sessionKey);
    if (sessionId && this.client) {
      try {
        await this.client.cancel({ sessionId });
      } catch {
        // Session may already be dead
      }
    }
    this.sessions.delete(sessionKey);
  }

  async sendInterrupt(): Promise<void> {
    // Cancel all active sessions
    if (!this.client) return;
    for (const sessionId of this.sessions.values()) {
      try {
        await this.client.cancel({ sessionId });
      } catch {
        // ignore
      }
    }
  }

  destroy(): void {
    if (this.agent) {
      this.agent.kill("SIGTERM");
      this.agent = null;
      this.client = null;
    }
  }

  private handleSessionUpdate(params: SessionNotification): void {
    const update = params.update;
    if (!("sessionUpdate" in update)) return;

    const sessionId = params.sessionId;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content?.type === "text") {
          const text = update.content.text;
          const chunks = this.responseChunks.get(sessionId);
          if (chunks) chunks.push(text);

          // Stream to callback if set
          if (this.onIntermediateResponse && text.trim()) {
            this.onIntermediateResponse(text);
          }
        }
        break;
      }
      case "tool_call": {
        logDebug(TAG, `[tool] ${update.title} (${update.status})`);
        break;
      }
      case "tool_call_update": {
        if (update.status) {
          logDebug(TAG, `[tool update] ${update.toolCallId}: ${update.status}`);
        }
        break;
      }
    }
  }

  private async handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (this.onPermissionRequest) {
      return this.onPermissionRequest(params);
    }

    // Default: auto-approve with first allow option (trust mode)
    const allowOption = params.options?.find(
      (o) => o.kind === "allow_once" || o.kind === "allow_always",
    );
    if (allowOption) {
      logDebug(TAG, `[permission auto-approved] ${params.toolCall?.title ?? "unknown"}`);
      return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
    }

    logWarn(TAG, `[permission cancelled] ${params.toolCall?.title ?? "unknown"}: no allow option`);
    return { outcome: { outcome: "cancelled" } };
  }

  private async getOrCreateSession(sessionKey: string): Promise<string> {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    if (!this.client) throw new Error("ACP not initialized");

    const session = await this.client.newSession({
      cwd: this.workingDir,
      mcpServers: [],
    });
    this.sessions.set(sessionKey, session.sessionId);
    logInfo(TAG, `Created session ${session.sessionId} for ${sessionKey}`);
    return session.sessionId;
  }
}
