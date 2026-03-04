import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import type { AcpResponse, AcpNotification, AcpMessage } from "../types/index.js";
import { serialize, parse, buildRequest } from "./jsonrpc.js";

export type AcpClientEvents = {
  notification: [AcpNotification];
  crash: [Error];
};

/**
 * Manages a kiro-cli ACP child process. Sends JSON-RPC requests
 * over stdin, reads newline-delimited responses/notifications from stdout.
 */
export class AcpClient extends EventEmitter<AcpClientEvents> {
  private process: ChildProcess | null = null;
  private readonly cliPath: string;
  private readonly workingDir: string;
  private pendingRequests = new Map<number, {
    resolve: (res: AcpResponse) => void;
    reject: (err: Error) => void;
  }>();
  private initialized = false;

  constructor(cliPath: string, workingDir: string) {
    super();
    this.cliPath = cliPath;
    this.workingDir = workingDir;
  }

  /** Spawn the kiro-cli acp child process and wire up stdio. */
  spawn(): void {
    if (this.process) {
      throw new Error("ACP process already running");
    }

    this.process = spawn(this.cliPath, ["acp"], {
      cwd: this.workingDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: this.process.stdout! });
    rl.on("line", (line) => this.handleLine(line));

    this.process.stderr?.on("data", (chunk: Buffer) => {
      // Log stderr for debugging but don't crash
      console.error(`[kiro-cli stderr] ${chunk.toString().trim()}`);
    });

    this.process.on("exit", (code, signal) => {
      this.process = null;
      this.initialized = false;
      // Reject all pending requests
      const err = new Error(`kiro-cli exited (code=${code}, signal=${signal})`);
      for (const [, pending] of this.pendingRequests) {
        pending.reject(err);
      }
      this.pendingRequests.clear();
      this.emit("crash", err);
    });
  }

  /** Send the initialize handshake. Must be called after spawn(). */
  async initialize(): Promise<AcpResponse> {
    const res = await this.sendRequest("initialize", {
      protocolVersion: "0.1",
      clientInfo: { name: "telegram-kiro-bridge", version: "0.1.0" },
      capabilities: {},
    });
    this.initialized = true;
    return res;
  }

  /** Create a new ACP session. Returns the session ID. */
  async createSession(cwd: string): Promise<string> {
    const res = await this.sendRequest("session/new", { cwd });
    const result = res.result as { sessionId: string } | undefined;
    if (!result?.sessionId) {
      throw new Error("session/new did not return a sessionId");
    }
    return result.sessionId;
  }

  /** Send a user prompt to an existing session. */
  async sendPrompt(sessionId: string, message: string): Promise<void> {
    await this.sendRequest("session/prompt", { sessionId, message });
  }

  /** Cancel an in-progress session. */
  async cancelSession(sessionId: string): Promise<void> {
    await this.sendRequest("session/cancel", { sessionId });
  }

  /** Respond to a permission request from kiro-cli. */
  async respondPermission(requestId: string, approved: boolean): Promise<void> {
    await this.sendRequest("session/request_permission/response", {
      requestId,
      approved,
    });
  }

  /** Whether the ACP process is alive and initialized. */
  get isReady(): boolean {
    return this.process !== null && this.initialized;
  }

  /** Kill the child process. */
  kill(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
      this.initialized = false;
    }
  }

  /** Send a JSON-RPC request and wait for the correlated response. */
  private sendRequest(method: string, params: Record<string, unknown>): Promise<AcpResponse> {
    if (!this.process?.stdin?.writable) {
      return Promise.reject(new Error("ACP process not running"));
    }

    const req = buildRequest(method, params);

    return new Promise<AcpResponse>((resolve, reject) => {
      this.pendingRequests.set(req.id, { resolve, reject });
      this.process!.stdin!.write(serialize(req), (err) => {
        if (err) {
          this.pendingRequests.delete(req.id);
          reject(err);
        }
      });
    });
  }

  /** Handle a single line of stdout from kiro-cli. */
  private handleLine(line: string): void {
    if (line.trim() === "") return;

    let msg: AcpMessage;
    try {
      msg = parse(line);
    } catch (err) {
      console.error(`[acp-client] Failed to parse: ${line}`, err);
      return;
    }

    // Response — correlate by id
    if ("id" in msg && typeof msg.id === "number") {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg as AcpResponse);
        }
      }
      return;
    }

    // Notification — emit for handlers
    this.emit("notification", msg as AcpNotification);
  }
}
