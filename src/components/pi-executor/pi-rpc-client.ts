import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { logDebug, logWarn, logError } from "../logger.js";
import type { PiRpcRequest, PiRpcResponse, PiRpcEvent, PiState, PiModel, PiSessionStats, PiUiReply } from "./pi-rpc-types.js";
import type { UiResponseResult } from "./types.js";
import { MAX_RPC_LINE_BYTES, MAX_STDERR_BYTES } from "./types.js";

const TAG = "pi-rpc";
const COMMAND_TIMEOUT_MS = 30_000;

export class PiRpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "PiRpcError";
  }
}

type RpcListener = (event: PiRpcEvent) => void;

export type PiProcessTermination =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "error"; error: Error };

type TerminationListener = (event: PiProcessTermination) => void;

interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PiRpcClient {
  private child: ChildProcess | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private stderrBuf = "";
  private readonly pending = new Map<string, PendingCommand>();
  private readonly listeners = new Set<RpcListener>();
  private readonly _terminationListeners = new Set<TerminationListener>();
  private _closed = false;
  private _ready = false;
  private _terminationFired = false;

  get closed(): boolean { return this._closed; }
  get ready(): boolean { return this._ready; }
  get pid(): number | undefined { return this.child?.pid; }

  /** Subscribe to exact child-process termination. Fires at most once. */
  onTermination(listener: TerminationListener): () => void {
    this._terminationListeners.add(listener);
    return () => { this._terminationListeners.delete(listener); };
  }

  async launch(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<void> {
    if (this.child) throw new PiRpcError("already_started", "Pi RPC client is already running");
    logDebug(TAG, `Launching: ${command} ${args.join(" ")}`);

    // #1405: Deny-by-default — only the passed env object is used, not process.env
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    this.child.on("exit", (code, signal) => {
      logDebug(TAG, `Pi process exited: code=${code} signal=${signal}`);
      this._fireTermination({ kind: "exit", code, signal });
      if (!this._closed) {
        this._rejectAll(new PiRpcError("process_exit", `Pi process exited (code=${code}, signal=${signal})`));
      }
    });
    this.child.on("error", (err) => {
      logError(TAG, `Pi process error: ${err.message}`);
      this._fireTermination({ kind: "error", error: err });
      if (!this._closed) this._rejectAll(new PiRpcError("process_error", err.message));
    });

    this.rl = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    this.rl.on("line", (line: string) => this._onLine(line));

    this.child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      this.stderrBuf += text;
      if (Buffer.byteLength(this.stderrBuf, "utf-8") > MAX_STDERR_BYTES) {
        this.stderrBuf = "[truncated] " + this.stderrBuf.slice(-MAX_STDERR_BYTES / 2);
      }
    });

    this.child.stdin!.on("error", () => {});
  }

  async getState(): Promise<PiState> {
    return this._command("get_state") as Promise<PiState>;
  }

  async prompt(text: string): Promise<void> {
    await this._command("prompt", { text });
  }

  async steer(text: string): Promise<void> {
    await this._command("steer", { text });
  }

  async followUp(text: string): Promise<void> {
    await this._command("follow_up", { text });
  }

  async abort(): Promise<void> {
    try { await this._command("abort"); } catch { /* best effort */ }
  }

  async getAvailableModels(): Promise<PiModel[]> {
    return this._command("get_available_models") as Promise<PiModel[]>;
  }

  async setModel(model: { provider: string; modelId: string; thinking?: string }): Promise<void> {
    await this._command("set_model", { model: model.modelId, provider: model.provider, thinking: model.thinking });
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this._command("set_thinking_level", { level });
  }

  async getLastAssistantText(): Promise<string> {
    return this._command("get_last_assistant_text") as Promise<string>;
  }

  async getSessionStats(): Promise<PiSessionStats> {
    return this._command("get_session_stats") as Promise<PiSessionStats>;
  }

  async respondToUi(requestId: string, value: PiUiReply): Promise<UiResponseResult> {
    // Phase 1: not writable — definitely not written
    if (this._closed) return { ok: false, delivery: "not_written", error: "closed" };
    if (!this.child?.stdin?.writable) return { ok: false, delivery: "not_written", error: "not_connected" };

    const id = randomUUID().slice(0, 8);
    const request: PiRpcRequest = { id, cmd: "extension_ui_response", args: { requestId, value } };

    // Phase 2: synchronous write — if it throws, it was not written
    let wrote = false;
    try {
      this.child!.stdin!.write(JSON.stringify(request) + "\n");
      wrote = true;
    } catch (err) {
      return { ok: false, delivery: "not_written", error: `write_error: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (!wrote) return { ok: false, delivery: "not_written", error: "write_returned_false" };

    // Phase 3: after write accepted — wait for outcome
    return new Promise<UiResponseResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, delivery: "written_unacknowledged", error: "timeout" });
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve({ ok: true, delivery: "acknowledged", result });
        },
        reject: (err) => {
          clearTimeout(timer);
          // Distinguish correlated Pi error responses from uncorrelated failures
          if (err instanceof PiRpcError && err.code === "rpc_error") {
            resolve({ ok: false, delivery: "acknowledged", error: err.message });
          } else {
            resolve({ ok: false, delivery: "written_unacknowledged", error: err.message });
          }
        },
        timer,
      });
    });
  }

  async switchSession(sessionFile: string): Promise<void> {
    await this._command("switch_session", { sessionFile });
  }

  subscribe(listener: RpcListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._fireTermination({ kind: "exit", code: null, signal: null });
    this._rejectAll(new PiRpcError("closed", "Pi RPC client closed"));
    if (this.rl) { this.rl.close(); this.rl = null; }
    if (this.child && !this.child.killed) {
      try { this.child.stdin?.end(); } catch { /* ignore */ }
      const { pid } = this.child;
      const killTimer = setTimeout(() => { try { process.kill(pid!, "SIGKILL"); } catch { /* ignore */ } }, 5000);
      this.child.on("exit", () => clearTimeout(killTimer));
      try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
    }
    this.child = null;
    this.listeners.clear();
  }

  getStderr(): string {
    return this.stderrBuf;
  }

  private async _command(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    if (this._closed) throw new PiRpcError("closed", "Pi RPC client is closed");
    if (!this.child?.stdin?.writable) throw new PiRpcError("not_connected", "Pi process not connected");
    const id = randomUUID().slice(0, 8);
    const request: PiRpcRequest = { id, cmd, args };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcError("timeout", `Command "${cmd}" timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child!.stdin!.write(JSON.stringify(request) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new PiRpcError("write_error", `Failed to write command "${cmd}": ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  private _onLine(line: string): void {
    if (Buffer.byteLength(line, "utf-8") > MAX_RPC_LINE_BYTES) {
      logWarn(TAG, `Oversized RPC line (${Buffer.byteLength(line, "utf-8")} bytes) — dropping`);
      return;
    }
    let parsed: PiRpcResponse;
    try {
      parsed = JSON.parse(line) as PiRpcResponse;
    } catch {
      logWarn(TAG, `Malformed RPC line: ${line.slice(0, 200)}`);
      return;
    }

    if (parsed.type === "event") {
      if (parsed.event && parsed.data) {
        const event: PiRpcEvent = { type: parsed.event as PiRpcEvent["type"], data: parsed.data as Record<string, unknown> | undefined };
        for (const listener of this.listeners) {
          try { listener(event); } catch (err) { logWarn(TAG, `RPC listener error: ${err instanceof Error ? err.message : String(err)}`); }
        }
      }
      return;
    }

    if (parsed.type === "error") {
      logWarn(TAG, `RPC error: ${parsed.error ?? "unknown"}`);
    }

    const pending = this.pending.get(parsed.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);

    if (parsed.type === "error" || parsed.ok === false) {
      pending.reject(new PiRpcError("rpc_error", parsed.error ?? "RPC command failed"));
    } else {
      this._ready = true;
      pending.resolve(parsed.result);
    }
  }

  private _fireTermination(event: PiProcessTermination): void {
    if (this._terminationFired) return;
    this._terminationFired = true;
    for (const listener of this._terminationListeners) {
      try { listener(event); } catch (err) { logWarn(TAG, `Termination listener error: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }

  private _rejectAll(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
