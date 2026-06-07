import { logAndSwallow } from "../log-and-swallow.js";
import { getEnv } from "../env-schema.js";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Write model into ~/.kiro/agents/{name}.json if it differs or is missing. */
function ensureAgentConfig(agentName: string, model: string): void {
  const dir = join(homedir(), ".kiro", "agents");
  const file = join(dir, `${agentName}.json`);
  try {
    if (existsSync(file)) {
      const existing = JSON.parse(readFileSync(file, "utf8"));
      if (existing.model === model) return; // already correct
      existing.model = model;
      writeFileSync(file, JSON.stringify(existing, null, 2) + "\n");
    } else {
      mkdirSync(dir, { recursive: true });
      const config = { name: agentName, model, tools: ["*"], allowedTools: ["@builtin"], includeMcpJson: true };
      writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    }
  } catch (err) { logAndSwallow(TAG, "ensureAgentConfig", err); }
}

export class ModelNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "ModelNotFoundError"; }
}

/**
 * Thrown when an in-flight ACP operation is rejected because the kiro-cli
 * child process exited. Callers can distinguish from timeouts and other
 * failures via `instanceof AcpExitError`. #160.
 */
export class AcpExitError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly reason = "exit" as const;

  constructor(code: number | null, signal: NodeJS.Signals | null) {
    super(`kiro-cli exited before operation completed (code=${code}, signal=${signal})`);
    this.name = "AcpExitError";
    this.code = code;
    this.signal = signal;
  }
}

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
import { writeRestartReason } from "../transport/bridge-lock-transport.js";
import { TransportStateMachine } from "./transport-state.js";

const TAG = "acp";

/**
 * ACP transport using @agentclientprotocol/sdk.
 * Spawns kiro-cli acp as a child process and communicates via JSON-RPC over stdio.
   * ACP streaming client.
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
  onToolCallStart?: (toolName: string) => void;

  /** Context window usage percentage from Kiro metadata. */
  get contextPercent(): number {
    return this.lastContextPercent;
  }

  /** ACP returns full response — no separate "answer only" extraction. */
  get answerOnly(): string { return ""; }
  private _toolCallsSucceeded = 0;
  get toolCallsSucceeded(): number { return this._toolCallsSucceeded; }

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
  /** Timestamp of last content-producing event (text chunk, tool completion). For timeout only. */
  private lastContentAt = 0;
  /** Currently in-flight tool call metadata (null if none). */
  private toolMeta: { title: string; startedAt: number } | null = null;
  /** @deprecated Use sm.isActive instead. Kept for external health check compat. */
  get toolInFlight(): { title: string; startedAt: number } | null { return this.toolMeta; }
  private _modelNotFound = false;
  /** Last prompt sent (for watchdog re-send). */
  lastPromptText = "";
  /** Last session key used (for watchdog re-send). */
  lastSessionKey = "";

  /** State machine — replaces _promptActive + toolInFlight flags (#188). */
  private readonly sm: import("./transport-state.js").TransportStateMachine;

  /** Optional callback for permission requests. Returns selected optionId or undefined to cancel. */
  onPermissionRequest?: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;

  constructor(cliPath: string, workingDir: string, opts?: { agent?: string; model?: string; cliArgs?: string[]; autoReinit?: boolean; tag?: string }) {
    this.cliPath = cliPath;
    this.workingDir = workingDir;
    this.agentName = opts?.agent ?? "professor";
    this.modelId = opts?.model;
    this.extraCliArgs = opts?.cliArgs;
    this.isGemini = !!opts?.cliArgs;
    this.autoReinit = opts?.autoReinit ?? true;
    this.tag = opts?.tag ?? "acp";
    this.sm = new TransportStateMachine({
      maxReinitFailures: 3,
      onTransition: (from, to) => logDebug(this.tag, `state: ${from} → ${to}`),
    });
  }

  private readonly agentName: string;
  private modelId?: string;
  private readonly extraCliArgs?: string[];
  private readonly isGemini: boolean;
  private readonly autoReinit: boolean;
  private readonly tag: string;

  async initialize(): Promise<void> {
    // Ensure kiro agent config has the correct model from transport.json
    if (this.modelId) {
      ensureAgentConfig(this.agentName, this.modelId);
    }

    let args: string[];
    if (this.extraCliArgs) {
      args = [...this.extraCliArgs];
    } else {
      args = ["acp", "--agent", this.agentName];
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
        // #160: reject all in-flight operations immediately
        if (this.inFlight.size > 0) {
          const err = new AcpExitError(code, signal);
          const count = this.inFlight.size;
          for (const entry of this.inFlight) entry.reject(err);
          this.inFlight.clear();
          logWarn(this.tag, `rejected ${count} in-flight ACP op(s) due to child exit`);
        }
        // #188: state machine handles reinit
        this.sm.childExited();
        this.toolMeta = null;
        if (this.sm.state === "reinitializing" && this.autoReinit) {
          logWarn(this.tag, "Unexpected kiro-cli exit — auto-reinitializing in 5s");
          setTimeout(() => {
            this.initialize()
              .then(() => this.sm.reinitSucceeded())
              .catch(e => { logError(this.tag, "Auto-reinit failed", e); this.sm.reinitFailed(); });
          }, 5000);
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
          if (method === "_kiro.dev/agent/not_found" || method === "_kiro.dev/model/not_found") {
            this._modelNotFound = true;
          }
        },
      }),
      stream,
    );

    logDebug(this.tag, "Initializing ACP connection");
    const initResult = await this.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "abtars", version: "1.0.0" },
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

  private _pendingPrompt: { sessionKey: string; message: string } | undefined;

  async sendPrompt(sessionKey: string, message: string, _image?: { mime: string; base64: string }, _userId?: string): Promise<string> {
    if (!this.client) {
      logWarn(this.tag, "ACP client dead — reinitializing");
      await this.initialize();
    }

    // Layer 2 (#671): queue concurrent prompts instead of crashing
    if (this.sm.state !== "idle") {
      logWarn(this.tag, `Concurrent prompt while ${this.sm.state} — queuing for after completion`);
      this._pendingPrompt = { sessionKey, message };
      return "";
    }

    this._toolCallsSucceeded = 0;
    const sessionId = await this.getOrCreateSession(sessionKey);
    this.responseChunks.set(sessionId, []);

    logDebug(this.tag, `Sending prompt to session ${sessionId}: "${message.replace(/\n/g, " ").slice(0, 80)}…"`);

    this.promptStartedAt = Date.now();
    this.lastActivityAt = Date.now();
    this.lastContentAt = Date.now();
    this.toolMeta = null;
    this.lastPromptText = message;
    this.lastSessionKey = sessionKey;
    this.sm.startPrompt();

    // client.prompt() blocks until the full turn completes.
    // While running, sessionUpdate fires for each agent_message_chunk.
    try {
      // #160: track in-flight so child-exit can reject immediately
      const result = await this.trackInFlight("prompt", sessionId, () => this.promptWithRetry(sessionId, message));

      logDebug(this.tag, `Prompt complete (stopReason: ${result.stopReason}, ctx: ${this.lastContextPercent}%)`);
      this.lastSuccessAt = Date.now();

      // #287: if model/agent not found was flagged during this session, reject the response
      if (this._modelNotFound) {
        this._modelNotFound = false;
        this.responseChunks.delete(sessionId);
        const model = this.modelId ?? "unknown";
        throw new ModelNotFoundError(`Model "${model}" not available — kiro-cli fell back to generic agent`);
      }

      const chunks = this.responseChunks.get(sessionId) ?? [];
      this.responseChunks.delete(sessionId);
      return chunks.join("") || "(no response)";
    } finally {
      // AfterPrompt hook — observe-only
      const durationMs = Date.now() - this.promptStartedAt;
      import("../hooks/hook-system.js").then(({ hasHooks, fire }) => {
        if (!hasHooks("AfterPrompt")) return;
        fire("AfterPrompt", {
          event: "AfterPrompt", timestamp: new Date().toISOString(),
          sessionKey, platform: "", userId: "",
          model: this.modelId ?? "unknown", durationMs,
          inputTokens: null, outputTokens: null,
        }).catch(err => logAndSwallow(TAG, "fire AfterPrompt", err));
      }).catch(err => logAndSwallow(TAG, "import hook-system", err));
      this.sm.promptCompleted();

      // Drain queued concurrent prompt (#671 Layer 2)
      if (this._pendingPrompt) {
        const pending = this._pendingPrompt;
        this._pendingPrompt = undefined;
        logInfo(this.tag, `Draining queued prompt after completion`);
        queueMicrotask(() => { this.sendPrompt(pending.sessionKey, pending.message).catch(err => logAndSwallow(TAG, "drain pending prompt", err)); });
      }
    }
  }

  private readonly _promptTimeoutMs = getEnv().promptTimeoutSec * 1000; // default 3 min

  /**
   * #160: tracks in-flight user-visible ACP operations so the child-exit
   * handler can reject them immediately instead of letting them wait for
   * the prompt timeout (or hang forever on code paths without a timeout).
   * `executeCommand` routes through `sendPrompt`, so it's protected via the
   * "prompt" op type.
   */
  private inFlight = new Set<{
    op: "prompt" | "cancel";
    sessionId: string | undefined;
    reject: (err: Error) => void;
  }>();

  /**
   * Wraps a user-visible ACP operation so that a child-process exit can
   * reject the caller immediately. Happy path adds one Set insert + delete.
   */
  private async trackInFlight<T>(
    op: "prompt" | "cancel",
    sessionId: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    let entry!: { op: typeof op; sessionId: string | undefined; reject: (err: Error) => void };
    const racer = new Promise<never>((_, reject) => {
      entry = { op, sessionId, reject };
      this.inFlight.add(entry);
    });
    try {
      return await Promise.race([work(), racer]);
    } finally {
      this.inFlight.delete(entry);
    }
  }

  private async promptWithRetry(sessionId: string, message: string, maxRetries = 2): Promise<{ stopReason: string }> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // #329: abort immediately if model is known-dead (flag set during handshake)
      if (this._modelNotFound) {
        throw new ModelNotFoundError(`Model "${this.modelId ?? "unknown"}" not available — use /model to switch`);
      }
      try {
        if (!this.client) throw new Error("ACP not initialized");
        this.lastActivityAt = Date.now();
        let timeoutTimer: ReturnType<typeof setInterval> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutTimer = setInterval(() => {
            if (Date.now() - this.lastContentAt > this._promptTimeoutMs) {
              clearInterval(timeoutTimer);
              reject(new Error("Bridge prompt timeout — model unresponsive"));
            }
          }, 5000);
        });
        const result = await Promise.race([
          this.client.prompt({
            sessionId,
            prompt: [{ type: "text", text: message }],
          }).finally(() => clearInterval(timeoutTimer)),
          timeoutPromise,
        ]);
        return result;
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
    // Re-read transport.json to pick up model changes from /model or /reset
    try {
      const { clearTransportCache, loadTransport, resolveAgent } = await import("../transport-config.js");
      clearTransportCache();
      const tc = loadTransport();
      if (tc) {
        const prof = resolveAgent("professor", tc);
        if (prof?.model) this.modelId = prof.model;
      }
    } catch (err) { logAndSwallow("acp_transport", "op", err); }
    this.destroy();
    await this.initialize();
  }

  async sendInterrupt(): Promise<void> {
    // Cancel all active sessions
    if (!this.client) return;
    for (const sessionId of this.sessions.values()) {
      try {
        // #160: track cancel op so child-exit can reject immediately
        await this.trackInFlight("cancel", sessionId, () => this.client!.cancel({ sessionId }));
      } catch (err) {
        // Cancel is best-effort; swallow but record
        if (err instanceof AcpExitError) {
          logDebug(this.tag, `cancel skipped (child exited): ${sessionId}`);
        }
        // else ignore — pre-existing behavior
      }
    }
  }

  destroy(): void {
    this.sessions.clear();
    // #160: reject any in-flight ops so they don't hang waiting for a child
    // that's about to be killed (or already gone).
    if (this.inFlight.size > 0) {
      const err = new AcpExitError(null, null);
      for (const entry of this.inFlight) entry.reject(err);
      this.inFlight.clear();
    }
    if (this.agent) {
      this.agent.kill("SIGTERM");
      this.agent = null;
      this.client = null;
    }
    logInfo(this.tag, "ACP transport destroyed");
  }

  async setModel(model: string): Promise<void> {
    this.modelId = model;
    // Don't restart here — caller (triggerNewSession → resetSession) handles it.
    logInfo(this.tag, `Model set to: ${model} (pending session reset)`);
  }

  async restartSession(): Promise<void> {
    this.destroy();
    await this.initialize();
    logInfo(this.tag, "Session restarted (CLI respawned)");
  }

  getModel(): string { return this.modelId ?? "unknown"; }

  private handleSessionUpdate(params: SessionNotification): void {
    const update = params.update;
    if (!("sessionUpdate" in update)) return;

    const sessionId = params.sessionId;

    // Guard: drop late events from a session that already completed/failed (#649)
    if ((this.sm.state === "idle" || this.sm.state === "destroyed") && !this.responseChunks.has(sessionId)) return;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content;
        if (content?.type === "text") {
          const text = content.text;
          const chunks = this.responseChunks.get(sessionId);
          if (chunks) chunks.push(text);
          this.lastActivityAt = Date.now();
          this.lastContentAt = Date.now();
          this.toolMeta = null; if (this.sm.state === "tool-active") this.sm.toolCompleted(); // model responding = tool done
          if (this.onIntermediateResponse && text.trim()) {
            this.onIntermediateResponse(text);
          }
        } else if ((content as { type?: string })?.type === "thinking") {
          const text = (content as { text?: string }).text ?? "";
          const chunks = this.responseChunks.get(sessionId);
          if (chunks) chunks.push(`\n[thinking] ${text}\n`);
          this.lastActivityAt = Date.now();
          // NOT updating lastContentAt — thinking is keepalive, not content
        }
        break;
      }
      case "tool_call": {
        logDebug(this.tag, `[tool] ${update.title} (${update.status})`);
        this.lastActivityAt = Date.now();
        this.lastContentAt = Date.now();
        this.toolMeta = { title: update.title ?? "unknown", startedAt: Date.now() }; this.sm.toolStarted();
        this.onToolCallStart?.(update.title ?? "tool");
        break;
      }
      case "tool_call_update": {
        if (update.status) {
          logDebug(this.tag, `[tool update] ${update.toolCallId}: ${update.status}`);
          this.lastActivityAt = Date.now();
          if (update.status === "completed") {
            this._toolCallsSucceeded++;
            this.toolMeta = null;
          } else if (update.status === "failed") {
            this.toolMeta = null;
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

    if (this.isGemini && this.modelId) {
      try { await this.client.unstable_setSessionModel({ sessionId: session.sessionId, modelId: this.modelId }); }
      catch { logWarn(this.tag, `unstable_setSessionModel not supported — using default model`); }
    }

    this.sessions.set(sessionKey, session.sessionId);
    logInfo(this.tag, `Created session ${session.sessionId} for ${sessionKey}`);
    return session.sessionId;
  }

  // --- Health check (called by heartbeat) ---

  private _watchdogL1Done = false;
  private _watchdogLastActionAt = 0;
  private readonly _watchdogCooldown = 60 * 60 * 1000;
  private readonly _toolTimeout = getEnv().watchdogToolTimeoutSec * 1000;
  private readonly _silentTimeout = getEnv().watchdogSilentSec * 1000;
  private readonly _endlessTimeout = getEnv().watchdogEndlessSec * 1000;

  async healthCheck(): Promise<void> {
    if (this.promptStartedAt <= this.lastSuccessAt) { this._watchdogL1Done = false; return; }

    const now = Date.now();
    if (now - this._watchdogLastActionAt < this._watchdogCooldown && this._watchdogL1Done) return;

    const silentMs = now - this.lastActivityAt;
    const totalMs = now - this.promptStartedAt;

    // Process dead
    if (!this.isConnected) {
      logWarn(this.tag, `[transport-health] Process dead — reinit + re-send`);
      this._watchdogLastActionAt = now;
      writeRestartReason("watchdog: process dead");
      await this.initialize();
      if (this.lastPromptText) await this.sendPrompt(this.lastSessionKey, this.lastPromptText);
      return;
    }

    // Tool hung
    if (this.toolMeta && now - this.toolMeta!.startedAt > this._toolTimeout) {
      const { title } = this.toolMeta!;
      const dur = Math.round((now - this.toolMeta!.startedAt) / 1000);
      logWarn(this.tag, `[transport-health] Tool "${title}" hung ${dur}s — interrupting`);
      this._watchdogLastActionAt = now;
      this.toolMeta = null;
      // Force idle BEFORE interrupt — so promptCompleted during cancel is a no-op (#870)
      if (this.sm.state === "tool-active") this.sm.transition("idle", "toolTimeout");
      await this.sendInterrupt();
      if (!this._watchdogL1Done) {
        await this.sendPrompt(this.lastSessionKey, `[SYSTEM] Your tool call "${title}" was interrupted after ${dur} seconds. Try a different approach.`);
        this._watchdogL1Done = true;
      }
      return;
    }

    // Endless loop (active but >10min)
    if (silentMs < this._silentTimeout && totalMs > this._endlessTimeout) {
      logWarn(this.tag, `[transport-health] Endless (${Math.round(totalMs / 1000)}s) — interrupting`);
      this._watchdogLastActionAt = now;
      await this.sendInterrupt();
      if (!this._watchdogL1Done) {
        await this.sendPrompt(this.lastSessionKey, "[SYSTEM] Interrupted — you appeared stuck in a loop. Please wrap up and respond to the user.");
        this._watchdogL1Done = true;
      }
      return;
    }

    // Silent (>5min, no tool) — but only if no prompt is actively awaiting
    if (silentMs > this._silentTimeout && !this.sm.isActive) {
      if (!this._watchdogL1Done) {
        logWarn(this.tag, `[transport-health] Silent ${Math.round(silentMs / 1000)}s — re-sending`);
        this._watchdogL1Done = true;
        this._watchdogLastActionAt = now;
        if (this.lastPromptText) await this.sendPrompt(this.lastSessionKey, this.lastPromptText);
      }
      // L2 handled by heartbeat watchdog timer (stale lastHeartbeat → restart)
    }
  }
}
