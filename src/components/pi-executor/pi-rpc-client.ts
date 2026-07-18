import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { logDebug, logWarn, logError } from "../logger.js";
import type {
  RpcCommand, RpcResponse, RpcExtensionUIRequest, RpcExtensionUIResponse,
  RpcEventListener, ExtensionError,
} from "@earendil-works/pi-coding-agent";
import type { UiResponseResult, PiUiReply } from "./types.js";
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

export type PiProcessTermination =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "error"; error: Error };

type TerminationListener = (event: PiProcessTermination) => void;

/**
 * Official Pi agent/RPC event delivered on stdout. The agent-session events
 * come from the package's public RpcEventListener signature; `extension_error`
 * is emitted directly by Pi's RPC mode (not via the session subscriber) so it is
 * modelled with the official ExtensionError shape rather than reinvented.
 */
export type PiAgentEvent =
  | Parameters<RpcEventListener>[0]
  | ({ type: "extension_error" } & ExtensionError);
type EventListener = (event: PiAgentEvent) => void;
type UiRequestListener = (request: RpcExtensionUIRequest) => void;

interface PendingEntry {
  commandType: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SupervisedPiRpcClient {
  private child: ChildProcess | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private stderrBuf = "";
  private readonly pending = new Map<string, PendingEntry>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly uiRequestListeners = new Set<UiRequestListener>();
  private readonly _terminationListeners = new Set<TerminationListener>();
  private _closed = false;
  private _ready = false;
  private _terminationFired = false;

  get closed(): boolean { return this._closed; }
  get ready(): boolean { return this._ready; }
  get pid(): number | undefined { return this.child?.pid; }

  onTermination(listener: TerminationListener): () => void {
    this._terminationListeners.add(listener);
    return () => { this._terminationListeners.delete(listener); };
  }

  async launch(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<void> {
    if (this.child) throw new PiRpcError("already_started", "Pi RPC client is already running");
    logDebug(TAG, `Launching: ${command} ${args.join(" ")}`);

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

  async getState(): Promise<{ sessionId: string; sessionFile?: string; isStreaming: boolean }> {
    const result = await this.send({ type: "get_state" });
    const data = (result as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
    return {
      sessionId: (data?.sessionId as string) ?? "",
      sessionFile: data?.sessionFile as string | undefined,
      isStreaming: (data?.isStreaming as boolean) ?? false,
    };
  }

  async prompt(text: string): Promise<void> {
    await this.send({ type: "prompt", message: text });
  }

  async steer(text: string): Promise<void> {
    await this.send({ type: "steer", message: text });
  }

  async followUp(text: string): Promise<void> {
    await this.send({ type: "follow_up", message: text });
  }

  async abort(): Promise<void> {
    try { await this.send({ type: "abort" }); } catch { }
  }

  async getAvailableModels(): Promise<Array<{ provider: string; id: string }>> {
    const result = await this.send({ type: "get_available_models" });
    const data = (result as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
    const models = data?.models as Array<{ provider: string; id: string }> | undefined;
    return models ?? [];
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.send({ type: "set_model", provider, modelId });
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.send({ type: "set_thinking_level", level: level as any });
  }

  async getLastAssistantText(): Promise<string | null> {
    const result = await this.send({ type: "get_last_assistant_text" });
    const data = (result as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
    return (data?.text as string) ?? null;
  }

  async getSessionStats(): Promise<Record<string, unknown>> {
    const result = await this.send({ type: "get_session_stats" });
    const data = (result as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
    return data ?? {};
  }

  async respondToUi(requestId: string, value: PiUiReply): Promise<UiResponseResult> {
    if (this._closed) return { ok: false, delivery: "not_written", error: "closed" };
    if (!this.child?.stdin?.writable) return { ok: false, delivery: "not_written", error: "not_connected" };

    let response: RpcExtensionUIResponse;
    if (value === null) {
      response = { type: "extension_ui_response", id: requestId, cancelled: true };
    } else if (typeof value === "boolean") {
      response = { type: "extension_ui_response", id: requestId, confirmed: value };
    } else {
      response = { type: "extension_ui_response", id: requestId, value: String(value) };
    }

    try {
      this.child!.stdin!.write(JSON.stringify(response) + "\n");
      return { ok: true, delivery: "written_unacknowledged" };
    } catch (err) {
      return { ok: false, delivery: "not_written", error: `write_error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async switchSession(sessionFile: string): Promise<{ cancelled: boolean }> {
    const result = await this.send({ type: "switch_session", sessionPath: sessionFile });
    const data = (result as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
    return { cancelled: (data?.cancelled as boolean) ?? false };
  }

  subscribe(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onUiRequest(listener: UiRequestListener): () => void {
    this.uiRequestListeners.add(listener);
    return () => this.uiRequestListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._fireTermination({ kind: "exit", code: null, signal: null });
    this._rejectAll(new PiRpcError("closed", "Pi RPC client closed"));
    if (this.rl) { this.rl.close(); this.rl = null; }
    if (this.child && !this.child.killed) {
      try { this.child.stdin?.end(); } catch { }
      const { pid } = this.child;
      const killTimer = setTimeout(() => { try { process.kill(pid!, "SIGKILL"); } catch { } }, 5000);
      this.child.on("exit", () => clearTimeout(killTimer));
      try { this.child.kill("SIGTERM"); } catch { }
    }
    this.child = null;
    this.eventListeners.clear();
    this.uiRequestListeners.clear();
  }

  getStderr(): string {
    return this.stderrBuf;
  }

  private async send(command: RpcCommand): Promise<unknown> {
    if (this._closed) throw new PiRpcError("closed", "Pi RPC client is closed");
    if (!this.child?.stdin?.writable) throw new PiRpcError("not_connected", "Pi process not connected");
    const id = randomUUID().slice(0, 8);
    const frame = { ...command, id } as RpcCommand;
    const cmdType = command.type;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcError("timeout", `Command "${cmdType}" timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { commandType: cmdType, resolve, reject, timer });
      try {
        this.child!.stdin!.write(JSON.stringify(frame) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new PiRpcError("write_error", `Failed to write command "${cmdType}": ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  private _onLine(line: string): void {
    if (Buffer.byteLength(line, "utf-8") > MAX_RPC_LINE_BYTES) {
      logWarn(TAG, `Oversized RPC line (${Buffer.byteLength(line, "utf-8")} bytes) — dropping`);
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      logWarn(TAG, `Malformed RPC line: ${line.slice(0, 200)}`);
      return;
    }

    const type = parsed.type;

    if (type === "response") {
      const response = parsed as unknown as RpcResponse;
      const responseId = response.id;
      if (!responseId) {
        logWarn(TAG, "Response without id — dropping");
        return;
      }
      const pending = this.pending.get(responseId);
      if (!pending) {
        logWarn(TAG, `Response id="${responseId}" has no matching pending request — dropping`);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(responseId);

      if (response.command && response.command !== pending.commandType) {
        logWarn(TAG, `Response command "${response.command}" does not match expected "${pending.commandType}" — rejecting`);
        pending.reject(new PiRpcError("command_mismatch",
          `Expected response for "${pending.commandType}" but got "${response.command}"`));
        return;
      }

      if (response.success === false) {
        pending.reject(new PiRpcError("rpc_error", (response as any).error ?? "RPC command failed"));
      } else {
        this._ready = true;
        pending.resolve(response);
      }
      return;
    }

    if (type === "extension_ui_request") {
      const request = parsed as unknown as RpcExtensionUIRequest;
      for (const listener of this.uiRequestListeners) {
        try { listener(request); } catch (err) { logWarn(TAG, `UI request listener error: ${err instanceof Error ? err.message : String(err)}`); }
      }
      return;
    }

    if (type && typeof type === "string") {
      const event = parsed as PiAgentEvent;
      for (const listener of this.eventListeners) {
        try { listener(event); } catch (err) { logWarn(TAG, `Event listener error: ${err instanceof Error ? err.message : String(err)}`); }
      }
      return;
    }

    logWarn(TAG, `Unrecognized RPC frame type "${String(type)}" — dropping`);
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
