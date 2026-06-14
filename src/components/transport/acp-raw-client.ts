/**
 * ACP Raw Client — fallback JSON-RPC over raw stdin/stdout (#924).
 * Used when the SDK's ndJsonStream/Web Streams layer breaks (kiro-cli #7554).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { logDebug, logWarn } from "../logger.js";

const TAG = "acp-raw";

type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

export class AcpRawClient {
  private child: ChildProcess | null = null;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private buf = "";
  private onNotification: NotificationHandler;
  private onExit: ((code: number | null, signal: string | null) => void) | null = null;

  constructor(
    private cliPath: string,
    private args: string[],
    private env: NodeJS.ProcessEnv,
    private cwd: string,
    onNotification: NotificationHandler,
  ) {
    this.onNotification = onNotification;
  }

  spawn(): void {
    this.child = spawn(this.cliPath, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
    });

    this.child.stdout!.on("data", (d: Buffer) => {
      this.buf += d.toString();
      const lines = this.buf.split("\n");
      this.buf = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          } else if (msg.method) {
            this.onNotification(msg.method, msg.params ?? {});
          }
        } catch { /* malformed line */ }
      }
    });

    this.child.stderr!.on("data", (d: Buffer) => {
      logDebug(TAG, `[stderr] ${d.toString().trim()}`);
    });

    this.child.on("exit", (code, signal) => {
      logWarn(TAG, `CLI exited (code=${code}, signal=${signal})`);
      // Reject all pending
      for (const [, p] of this.pending) p.reject(new Error(`CLI exited (code=${code})`));
      this.pending.clear();
      this.child = null;
      this.onExit?.(code, signal);
    });
  }

  setOnExit(handler: (code: number | null, signal: string | null) => void): void {
    this.onExit = handler;
  }

  private request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("CLI not running"));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params, id });
    logDebug(TAG, `→ ${method} (id=${id}, ${payload.length} bytes)`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin!.write(payload + "\n");
    });
  }

  async initialize(): Promise<{ agentInfo: { name: string; version: string } }> {
    return this.request("initialize", {
      protocolVersion: "2025-11-16",
      capabilities: {},
      clientInfo: { name: "abtars", version: "0.2.3" },
    });
  }

  async newSession(params: { cwd: string; mcpServers: unknown[] }): Promise<{ sessionId: string }> {
    return this.request("session/new", params);
  }

  async prompt(params: { sessionId: string; prompt: Array<{ type: string; text: string }> }): Promise<{ stopReason: string }> {
    return this.request("session/prompt", params);
  }

  get pid(): number | undefined { return this.child?.pid; }
  get alive(): boolean { return this.child !== null; }

  destroy(): void {
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    for (const [, p] of this.pending) p.reject(new Error("destroyed"));
    this.pending.clear();
  }
}
