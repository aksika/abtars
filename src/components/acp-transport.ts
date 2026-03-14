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
const TEMP_THROTTLE_MS = 2000; // TEMPORARY — remove after testing

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
  private lastContextPercent = -1;

  /** Optional callback for streaming intermediate responses. */
  onIntermediateResponse?: (text: string) => void;

  /** Context window usage percentage from Kiro metadata. */
  get contextPercent(): number {
    return this.lastContextPercent;
  }

  /** Optional callback for permission requests. Returns selected optionId or undefined to cancel. */
  onPermissionRequest?: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;

  constructor(cliPath: string, workingDir: string, opts?: { skipAgent?: boolean }) {
    this.cliPath = cliPath;
    this.workingDir = workingDir;
    this.skipAgent = opts?.skipAgent ?? false;
  }

  private readonly skipAgent: boolean;

  async initialize(): Promise<void> {
    const args = this.skipAgent ? ["acp"] : ["acp", "--agent", "professor"];
    this.agent = spawn(this.cliPath, args, {
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
        extNotification: async (method: string, params: Record<string, unknown>) => {
          logDebug(TAG, `[ext] ${method}`);
          if (method === "_kiro.dev/metadata") {
            const pct = params["contextUsagePercentage"];
            if (typeof pct === "number") this.lastContextPercent = Math.ceil(pct);
          }
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

    // TEMPORARY throttle — avoid overloading kiro-cli
    await new Promise((r) => setTimeout(r, TEMP_THROTTLE_MS));

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

  async resetSession(_sessionKey: string): Promise<void> {
    // Kill and respawn the entire ACP process so the new first session
    // gets --agent professor again. Just deleting the session would create
    // session #2 which loses the agent identity.
    this.destroy();
    await this.initialize();
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
    this.sessions.clear();
    if (this.agent) {
      this.agent.kill("SIGTERM");
      this.agent = null;
      this.client = null;
    }
    logInfo(TAG, "ACP transport destroyed");
  }

  private handleSessionUpdate(params: SessionNotification): void {
    const update = params.update;
    if (!("sessionUpdate" in update)) return;

    const sessionId = params.sessionId;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content;
        if (content?.type === "text") {
          const text = content.text;
          const chunks = this.responseChunks.get(sessionId);
          if (chunks) chunks.push(text);
          if (this.onIntermediateResponse && text.trim()) {
            this.onIntermediateResponse(text);
          }
        } else if ((content as { type?: string })?.type === "thinking") {
          const text = (content as { text?: string }).text ?? "";
          const chunks = this.responseChunks.get(sessionId);
          if (chunks) chunks.push(`\n[thinking] ${text}\n`);
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
