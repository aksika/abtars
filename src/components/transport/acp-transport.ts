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
import { logInfo, logDebug, logWarn, logError } from "../logger.js";

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

  /** ACP returns full response — no separate "answer only" extraction. */
  get answerOnly(): string { return ""; }

  /** ACP doesn't track intermediate delivered text (edit-in-place instead). */
  get intermediateDeliveredText(): string { return ""; }

  get isConnected(): boolean {
    return this.agent !== null && this.client !== null;
  }

  /** Timestamp of last successful prompt. */
  lastSuccessAt = 0;
  /** Timestamp of last prompt start. */
  promptStartedAt = 0;
  /** Timestamp of last ACP activity (chunk, tool call, thinking). */
  lastActivityAt = 0;
  /** Currently in-flight tool call (null if none). */
  toolInFlight: { title: string; startedAt: number } | null = null;
  /** Last prompt sent (for watchdog re-send). */
  lastPromptText = "";
  /** Last session key used (for watchdog re-send). */
  lastSessionKey = "";

  /** Optional callback for permission requests. Returns selected optionId or undefined to cancel. */
  onPermissionRequest?: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;

  constructor(cliPath: string, workingDir: string, opts?: { skipAgent?: boolean; agent?: string; model?: string; cliArgs?: string[]; autoReinit?: boolean; tag?: string }) {
    this.cliPath = cliPath;
    this.workingDir = workingDir;
    this.skipAgent = opts?.skipAgent ?? false;
    this.agentName = opts?.agent ?? "professor";
    this.modelId = opts?.model;
    this.extraCliArgs = opts?.cliArgs;
    this.autoReinit = opts?.autoReinit ?? true;
    this.tag = opts?.tag ?? "acp";
  }

  private readonly skipAgent: boolean;
  private readonly agentName: string;
  private modelId?: string;
  private readonly extraCliArgs?: string[];
  private readonly autoReinit: boolean;
  private readonly tag: string;

  async initialize(): Promise<void> {
    let args: string[];
    if (this.extraCliArgs) {
      // Custom CLI args (e.g. gemini --experimental-acp)
      args = [...this.extraCliArgs];
      if (this.modelId) args.push("--model", this.modelId);
    } else {
      args = this.skipAgent ? ["acp"] : ["acp", "--agent", this.agentName];
      if (this.modelId) args.push("--model", this.modelId);
    }
    this.agent = spawn(this.cliPath, args, {
      cwd: this.workingDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!this.agent.stdin || !this.agent.stdout) {
      throw new Error("Failed to create ACP stdio pipes");
    }

    this.agent.stderr?.on("data", (chunk: Buffer) => {
      logDebug(this.tag, `[stderr] ${chunk.toString().trim()}`);
    });

    const thisProcess = this.agent;
    this.agent.on("exit", (code, signal) => {
      logWarn(this.tag, `kiro-cli exited (code=${code}, signal=${signal})`);
      if (this.agent === thisProcess) {
        this.agent = null;
        this.client = null;
        // Auto-reinitialize on unexpected exit
        if ((code !== 0 || signal) && this.autoReinit) {
          logWarn(this.tag, "Unexpected kiro-cli exit — auto-reinitializing in 5s");
          setTimeout(() => this.initialize().catch(e => logError(this.tag, "Auto-reinit failed", e)), 5000);
        }
      }
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
          logDebug(this.tag, `[ext] ${method}`);
          if (method === "_kiro.dev/metadata") {
            const pct = params["contextUsagePercentage"];
            if (typeof pct === "number") {
              this.lastContextPercent = Math.ceil(pct);
            }
          }
        },
      }),
      stream,
    );

    logDebug(this.tag, "Initializing ACP connection");
    const initResult = await this.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "agentbridge", version: "1.0.0" },
    });
    logInfo(this.tag, `ACP initialized (agent: ${initResult.agentInfo?.name ?? "unknown"})`);
  }

  get isReady(): boolean {
    return this.agent !== null && this.client !== null;
  }

  readonly transportCommands = ["/usage", "/model"];

  async executeCommand(cmd: string): Promise<string> {
    // Send as prompt to the active session — these are in-session commands
    const sessionKey = [...this.sessions.keys()][0];
    if (!sessionKey) return "No active session.";
    try {
      return await this.sendPrompt(sessionKey, cmd);
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async sendPrompt(sessionKey: string, message: string): Promise<string> {
    if (!this.client) {
      logWarn(this.tag, "ACP client dead — reinitializing");
      await this.initialize();
    }

    const sessionId = await this.getOrCreateSession(sessionKey);
    this.responseChunks.set(sessionId, []);

    logDebug(this.tag, `Sending prompt to session ${sessionId}: "${message.replace(/\n/g, " ").slice(0, 80)}…"`);

    this.promptStartedAt = Date.now();
    this.lastActivityAt = Date.now();
    this.toolInFlight = null;
    this.lastPromptText = message;
    this.lastSessionKey = sessionKey;

    // client.prompt() blocks until the full turn completes.
    // While running, sessionUpdate fires for each agent_message_chunk.
    const result = await this.promptWithRetry(sessionId, message);

    logDebug(this.tag, `Prompt complete (stopReason: ${result.stopReason}, ctx: ${this.lastContextPercent}%)`);
    this.lastSuccessAt = Date.now();

    const chunks = this.responseChunks.get(sessionId) ?? [];
    this.responseChunks.delete(sessionId);
    return chunks.join("") || "(no response)";
  }

  private async promptWithRetry(sessionId: string, message: string, maxRetries = 2): Promise<{ stopReason: string }> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (!this.client) throw new Error("ACP not initialized");
        return await this.client.prompt({
          sessionId,
          prompt: [{ type: "text", text: message }],
        });
      } catch (err: unknown) {
        const code = (err as { code?: number }).code;
        if (code === -32603 && attempt < maxRetries) {
          logWarn(this.tag, `Transient error (code ${code}), retry ${attempt + 1}/${maxRetries}`);
          this.responseChunks.set(sessionId, []); // reset chunks for retry
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw err;
      }
    }
    throw new Error("unreachable");
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
    logInfo(this.tag, "ACP transport destroyed");
  }

  async setModel(model: string): Promise<void> {
    this.modelId = model;
    this.destroy();
    await this.initialize();
    logInfo(this.tag, `Model switched to: ${model} (session reset)`);
  }

  getModel(): string { return this.modelId ?? process.env["AGENT_MODEL"] ?? "unknown"; }

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
          this.lastActivityAt = Date.now();
          this.toolInFlight = null; // model responding = tool done
          if (this.onIntermediateResponse && text.trim()) {
            this.onIntermediateResponse(text);
          }
        } else if ((content as { type?: string })?.type === "thinking") {
          const text = (content as { text?: string }).text ?? "";
          const chunks = this.responseChunks.get(sessionId);
          if (chunks) chunks.push(`\n[thinking] ${text}\n`);
          this.lastActivityAt = Date.now();
        }
        break;
      }
      case "tool_call": {
        logDebug(this.tag, `[tool] ${update.title} (${update.status})`);
        this.lastActivityAt = Date.now();
        this.toolInFlight = { title: update.title ?? "unknown", startedAt: Date.now() };
        break;
      }
      case "tool_call_update": {
        if (update.status) {
          logDebug(this.tag, `[tool update] ${update.toolCallId}: ${update.status}`);
          this.lastActivityAt = Date.now();
          if (update.status === "completed" || update.status === "failed") {
            this.toolInFlight = null;
          }
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
      logDebug(this.tag, `[permission auto-approved] ${params.toolCall?.title ?? "unknown"}`);
      return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
    }

    logWarn(this.tag, `[permission cancelled] ${params.toolCall?.title ?? "unknown"}: no allow option`);
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
    logInfo(this.tag, `Created session ${session.sessionId} for ${sessionKey}`);
    return session.sessionId;
  }
}
