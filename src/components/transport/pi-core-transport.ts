import { logDebug, logInfo } from "../logger.js";
import type { IKiroTransport, PromptRequestContext, RuntimeUsageSnapshot, RuntimeStatusSnapshot } from "./kiro-transport.js";
import type { CandidateSpec, ModelCandidate } from "./model-candidates.js";
import type { ModelHealthRegistry } from "./model-health-registry.js";
import { FallbackPolicy } from "./fallback-policy.js";
import { PiCoreExecutionHost } from "./pi-core-host.js";
import { PiCoreContextProjection, DurableContextUnavailableError } from "./pi-core-context.js";
import { createPiStreamFn } from "./pi-stream-fn.js";
import { createPiAgentTools } from "./pi-core-tools.js";
import type { PiCoreToolContext } from "./pi-core-tools.js";
import { createPiExecutionSafetyController } from "./pi-core-safety.js";
import type { SandboxPolicy } from "../tool-sandbox.js";
import type { AgentMessage } from "./pi-core-types.js";
import { createCurrentTurnMessage } from "./pi-core-types.js";
import type { OutputObserver } from "../session-output-feed.js";
import type { DurableContextProviderHolder } from "./pi-core-context.js";
import { buildPiModel, pickPiApi } from "./pi-ai-adapter.js";
import { candidateKey } from "./model-candidates.js";
import { PiCoreToolExecutionError, buildSafetyDiagnostic, mergeSafetyIncident } from "./tool-failure-diagnostic.js";
import type { ToolFailureDiagnosticV1 } from "./tool-failure-diagnostic.js";

const TAG = "pi-core-transport";

export function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => (
      typeof part === "object"
      && part !== null
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
    ))
    .map((part) => part.text)
    .join("");
}

export interface PiCoreTransportOptions {
  role: "main" | "specialist" | "background" | "task";
  systemPrompt: string;
  candidates: ModelCandidate[];
  healthRegistry: ModelHealthRegistry;
  sandboxPolicy: SandboxPolicy;
  session?: { instructionQueue: Array<import("../spin-types.js").QueuedSessionInstruction>; id: string };
  /** #1527: late-bound durable context provider holder (parallel boot composition). */
  contextProvider?: DurableContextProviderHolder;
  maxPromptRounds?: number;
  maxCandidateRounds?: number;
}

let executionSeq = 0;

/**
 * #1531: Execution-local steering slot. Created synchronously at the start of
 * `sendPrompt()` before its first await so a steer arriving while the Pi host
 * is still opening captures the slot and waits for host readiness instead of
 * hitting a dead-host error. Only one slot may be active on a transport;
 * finalization clears it only if it still owns the same generation.
 */
interface ActivePiExecution {
  generation: number;
  hostReady: Promise<PiCoreExecutionHost>;
  resolveHost(host: PiCoreExecutionHost): void;
  rejectHost(error: unknown): void;
  settled: boolean;
}

export class PiCoreTransport implements IKiroTransport {
  readonly config: { candidates: ModelCandidate[]; systemPrompt: string; role: string };
  private policy: FallbackPolicy;
  private healthRegistry: ModelHealthRegistry;
  private sandboxPolicy: SandboxPolicy;
  private session?: PiCoreTransportOptions["session"];
  private maxPromptRounds?: number;
  private maxCandidateRounds?: number;
  private maxToolRoundsOverride: number | null = null;
  private timeoutOverrideMs: number | null = null;
  private activeHost: PiCoreExecutionHost | null = null;
  private activeSlot: ActivePiExecution | null = null;
  private _executionGeneration = 0;
  private _isReady = false;
  private _lastUsage: RuntimeUsageSnapshot | null = null;

  /** #1527: late-bound durable context provider; populated once memory is ready. */
  private _contextProvider: DurableContextProviderHolder;
  private _toolCallsSucceeded = 0;
  private _lastResponse = "";
  private _intermediateText = "";
  /** Most recent tool failure diagnostic from the current sendPrompt call. */
  private _lastToolFailure: ToolFailureDiagnosticV1 | null = null;

  /** Last candidate that produced semantic output; reused by specialists. */
  lastSuccessfulCandidate: CandidateSpec | null = null;
  onLastSuccessfulChanged?: (candidate: CandidateSpec) => void;

  onReady?: () => void;
  onIntermediateResponse?: (text: string) => void;
  onToolCallStart?: (toolName: string) => void;
  onSegmentBreak?: (text: string) => void;

  constructor(opts: PiCoreTransportOptions) {
    this.config = { candidates: opts.candidates, systemPrompt: opts.systemPrompt, role: opts.role };
    this.healthRegistry = opts.healthRegistry;
    this.sandboxPolicy = opts.sandboxPolicy;
    this.session = opts.session;
    this._contextProvider = opts.contextProvider ?? { current: null };
    this.maxPromptRounds = opts.maxPromptRounds;
    this.maxCandidateRounds = opts.maxCandidateRounds;
    this.policy = new FallbackPolicy(opts.candidates, opts.healthRegistry);
  }

  get isReady(): boolean { return this._isReady; }
  get contextPercent(): number { return -1; }
  get answerOnly(): string { return this._lastResponse; }
  get toolCallsSucceeded(): number { return this._toolCallsSucceeded; }
  get intermediateDeliveredText(): string { return this._intermediateText; }
  get transportCommands(): string[] { return []; }

  setSystemPrompt(prompt: string): void {
    this.config.systemPrompt = prompt;
  }

  async setModel(model: string, endpoint?: string, maxContext?: number): Promise<void> {
    const primary = this.config.candidates[0];
    if (!primary) throw new Error("No model candidate configured");
    primary.model = model;
    if (endpoint) primary.endpoint = endpoint;
    if (maxContext) primary.maxContext = maxContext;
    this.policy = new FallbackPolicy(this.config.candidates, this.healthRegistry);
  }

  setTimeoutOverride(ms: number | null): void { this.timeoutOverrideMs = ms; }

  setMaxToolRoundsOverride(rounds: number | null): void { this.maxToolRoundsOverride = rounds; }

  /**
   * #1531: Per-lease steering acknowledgement. Captures the current execution
   * slot, waits for its host readiness, rechecks that the same execution is
   * still current, then delegates to the host's per-lease operation. Never
   * waits for the execution-wide settlement latch and never returns response
   * text — the initial send promise owns the final response.
   */
  async steer(content: string, lease: import("../spin-types.js").InstructionLease): Promise<void> {
    const host = await this.waitActiveHost("steer");
    await host.steer(content, lease);
  }

  async followUp(content: string, lease: import("../spin-types.js").InstructionLease): Promise<void> {
    const host = await this.waitActiveHost("follow-up");
    await host.followUp(content, lease);
  }

  /**
   * #1531: Resolve the active execution's host for a per-lease handoff.
   * Throws when no execution slot exists, when readiness fails (pre-host send
   * failure), or when the execution is no longer current after the wait.
   */
  private async waitActiveHost(op: "steer" | "follow-up"): Promise<PiCoreExecutionHost> {
    const slot = this.activeSlot;
    if (!slot) throw new Error(`No active Pi execution to ${op}`);
    let host: PiCoreExecutionHost;
    try {
      host = await slot.hostReady;
    } catch (err) {
      throw new Error(`Pi execution failed before ${op} readiness: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.activeSlot !== slot || slot.settled) {
      throw new Error(`Pi execution is no longer current — ${op} rejected`);
    }
    // Wait for native-steering readiness (state "running"): an instruction
    // accepted while the host is still opening must wait, not fail spuriously.
    try {
      await host.ready;
    } catch (err) {
      throw new Error(`Pi execution never became steerable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.activeSlot !== slot || slot.settled || host.isSettled) {
      throw new Error(`Pi execution is no longer active — ${op} rejected`);
    }
    return host;
  }

  private createActiveSlot(): ActivePiExecution {
    let resolveHost!: (host: PiCoreExecutionHost) => void;
    let rejectHost!: (error: unknown) => void;
    const hostReady = new Promise<PiCoreExecutionHost>((resolve, reject) => {
      resolveHost = resolve;
      rejectHost = reject;
    });
    // Pre-attach a handler so a rejection nobody awaited (pre-host send
    // failure without any steer in flight) is never an unhandled rejection.
    void hostReady.catch(() => {});
    const slot: ActivePiExecution = {
      generation: ++this._executionGeneration,
      hostReady,
      resolveHost,
      rejectHost,
      settled: false,
    };
    this.activeSlot = slot;
    return slot;
  }

  private clearActiveSlot(slot: ActivePiExecution): void {
    if (this.activeSlot === slot) this.activeSlot = null;
  }

  async initialize(): Promise<void> {
    this._isReady = true;
    this.onReady?.();
  }

  async sendPrompt(
    sessionKey: string,
    message: string,
    image?: { mime: string; base64: string },
    context?: PromptRequestContext,
  ): Promise<string> {
    // #1531: the execution slot exists synchronously before the first await so
    // a steer arriving while the Pi host is still opening can wait on it. It
    // is resolved with the constructed host, rejected on every pre-host
    // failure, and cleared only by its owning generation's finalizer.
    const slot = this.createActiveSlot();
    try {
      // Reset per-call state
      this._lastResponse = "";
      this._intermediateText = "";
      this._toolCallsSucceeded = 0;
      this._lastToolFailure = null;

      // #1529: fail closed when durable context is required but unavailable.
      // The intent is computed in prompt construction; an omitted intent means
      // the caller is outside the inbound durable pipeline (not-required). The
      // rejection happens before model selection, stream construction, Pi
      // loading, host construction, fallback, or any provider request.
      const durableIntent = context?.durableContextIntent ?? { mode: "not_required" as const };
      const callerUserId = context?.userId;
      if (durableIntent.mode === "required_unavailable") {
        logDebug(TAG, "durable intent required_unavailable — rejecting before provider boundary");
        throw new DurableContextUnavailableError("cursor_unavailable");
      }
      if (durableIntent.mode === "durable" && !callerUserId) {
        logDebug(TAG, "durable intent without caller identity — rejecting before provider boundary");
        throw new DurableContextUnavailableError("identity_unavailable");
      }

      // Use provided executionId or allocate a new one
      const executionId = context?.executionId ?? `${sessionKey}_${Date.now()}_${++executionSeq}`;

      const modelForCandidate = (key: string) => {
        const candidate = this.config.candidates.find((item) => candidateKey(item.model, item.endpoint) === key);
        if (!candidate) return undefined;
        return buildPiModel({
          model: candidate.model,
          endpoint: candidate.endpoint,
          apiKey: candidate.apiKey,
          apiFormat: candidate.apiFormat,
          thinking: candidate.thinking,
          maxOutput: 4096,
          contextWindow: candidate.maxContext,
        }, pickPiApi(candidate.apiFormat), Boolean(image), candidate.provider);
      };
      const safety = createPiExecutionSafetyController(this.policy, {
        maxPromptRounds: this.maxToolRoundsOverride ?? this.maxPromptRounds,
        maxCandidateRounds: this.maxCandidateRounds,
        modelForCandidate,
      });

      // Build current-turn marker with image content
      const currentTurn = createCurrentTurnMessage(
        message,
        executionId,
        sessionKey,
        durableIntent.mode === "durable" ? durableIntent.beforeMessageId : undefined,
      );
      if (image) {
        (currentTurn as { imageContent?: Array<{ mime: string; base64: string }> }).imageContent = [image];
      }

      // Context seed: durable vs ephemeral. A durable seed requires the
      // just-persisted cursor and a non-empty caller identity, both enforced by
      // the #1529 preflight above.
      const source = durableIntent.mode === "durable"
        ? { mode: "durable" as const, sessionKey, beforeMessageId: durableIntent.beforeMessageId, maxContext: this.config.candidates[0]?.maxContext ?? 128000, userId: callerUserId! }
        : { mode: "ephemeral" as const, sessionKey };

      const volatileBlocks: Array<{ kind: string; content: string }> = [];
      if (context?.directContextTurn?.volatileBlocks) {
        volatileBlocks.push(...context.directContextTurn.volatileBlocks);
      }

      const systemPrompt = this.config.systemPrompt;

      // Build the Pi model
      const first = this.config.candidates[0];
      const piModel = first
        ? buildPiModel({
          model: first.model,
          endpoint: first.endpoint,
          apiKey: first.apiKey,
          apiFormat: first.apiFormat,
          thinking: first.thinking,
          maxOutput: 4096,
          contextWindow: first.maxContext,
        }, pickPiApi(first.apiFormat), Boolean(image), first.provider)
        : buildPiModel({ model: "unknown", endpoint: "", maxOutput: 4096, contextWindow: 128000 }, pickPiApi(), Boolean(image), "unknown");

      const timeoutOverride = this.timeoutOverrideMs;
      const deadlineAt = context?.deadlineAt
        ?? (timeoutOverride && timeoutOverride > 0 ? Date.now() + timeoutOverride : undefined);

      // Build StreamFn — no emergency L0, no legacy conversion
      const streamFn = createPiStreamFn({
        policy: this.policy,
        executionId,
        telemetry: context?.executionTelemetry,
        deadlineAt,
        providerInactivityTimeoutMs: 180_000,
        onCandidateCommitted: (candidate) => {
          const successful: CandidateSpec = {
            model: candidate.model,
            provider: candidate.provider,
            endpoint: candidate.endpoint,
            maxContext: candidate.maxContext,
            apiFormat: candidate.apiFormat,
            thinking: candidate.thinking,
          };
          this.lastSuccessfulCandidate = successful;
          this.onLastSuccessfulChanged?.(successful);
          logDebug(TAG, `Candidate committed: ${candidate.model}`);
        },
      });

      // Build registry-derived tools
      const toolContext: PiCoreToolContext = {
        executionId,
        userId: context?.userId ?? "unknown",
        signal: undefined,
        sandboxPolicy: this.sandboxPolicy,
        safety,
        onToolFailure: (diag) => {
          this._lastToolFailure = diag;
        },
        executionScope: context?.executionScope,
        orcContext: context?.orcContext,
      };
      const tools = createPiAgentTools(toolContext);

      // Build context projection with the shared durable provider when available
      const contextProjection = new PiCoreContextProjection(
        { source, executionId, currentTurn, volatileBlocks },
        systemPrompt,
      );

      const hostMessages: AgentMessage[] = [
        currentTurn as unknown as AgentMessage,
      ];

      // Collect response text and tool info from events
      let responseText = "";

      const outputObserver: OutputObserver | undefined = context?.outputObserver;

      const host = new PiCoreExecutionHost({
        executionId,
        sessionId: sessionKey,
        initialState: {
          systemPrompt,
          model: piModel,
          messages: hostMessages,
          tools: tools as unknown as import("@earendil-works/pi-agent-core").AgentTool<any>[],
        },
        streamFn,
        session: this.session,
        executionTelemetry: context?.executionTelemetry,
        safety,
        contextProjection,
        transformOptions: {
          signal: undefined,
          hostGeneration: 0,
          contextProvider: context?.contextProvider ?? this._contextProvider.current ?? undefined,
          candidateKeyFn: () => {
            const candidate = this.policy.selectModel();
            return candidate ? candidateKey(candidate.model, candidate.endpoint) : executionId;
          },
          candidateModelFn: modelForCandidate,
        },
        outputObserver,
        onEvent: (event) => {
          if (event.type === "tool_execution_start") {
            this.onToolCallStart?.(event.toolName);
          }
          if (event.type === "message_end") {
            const msg = event.message as unknown as { role?: string; content?: unknown };
            if (msg.role === "assistant") {
              const text = extractAssistantText(msg.content);
              responseText = text;
              this._lastResponse = text;
            }
          }
          if (event.type === "message_update") {
            const streamEv = event.assistantMessageEvent as { type?: string; delta?: string } | null;
            if (streamEv?.type === "text_delta" && streamEv.delta) {
              this._intermediateText += streamEv.delta;
              this.onIntermediateResponse?.(streamEv.delta);
            }
          }
          if (event.type === "tool_execution_end" && !event.isError) {
            this._toolCallsSucceeded++;
          }
          return Promise.resolve();
        },
      });

      slot.resolveHost(host);
      this.activeHost = host;

      try {
        const { loadAndValidatePiAgentCore } = await import("./pi-core-types.js");
        const loaded = await loadAndValidatePiAgentCore();
        await host.start(loaded);
        // #1506: waitForSettlement() awaits only logical terminal latch.
        // Deadline enforcement belongs to the scheduled runner via signalCancel.
        await host.waitForSettlement();
        slot.settled = true;

        if (context?.executionTelemetry) {
          const snap = context.executionTelemetry.snapshot();
          if (snap) this._lastUsage = snap;
        }

        if (responseText.trim() !== "") {
          logDebug(TAG, `sendPrompt: returning ${responseText.length}ch assistant text`);
          return responseText;
        }

        if (this._lastToolFailure) {
          const incident = safety.lastTerminalIncident;
          const merged = mergeSafetyIncident(
            this._lastToolFailure,
            incident?.type,
            incident?.type === "candidate_round_limit",
          );
          logInfo(TAG, `sendPrompt: empty response with terminal tool failure — throwing diagnostic`);
          throw new PiCoreToolExecutionError(merged);
        }

        if (safety.terminalSafetyFailure && safety.lastTerminalIncident) {
          logInfo(TAG, `sendPrompt: terminal Pi safety failure (${safety.lastTerminalIncident.type})`);
          throw new PiCoreToolExecutionError(buildSafetyDiagnostic(executionId, safety.lastTerminalIncident));
        }

        logDebug(TAG, `sendPrompt: empty response with no tool failure — returning ""`);
        return "";
      } finally {
        if (this.activeHost === host) this.activeHost = null;
      }
    } catch (err) {
      slot.rejectHost(err);
      throw err;
    } finally {
      this.clearActiveSlot(slot);
    }
  }

  async resetSession(_sessionKey: string): Promise<void> {
    this.policy = new FallbackPolicy(this.config.candidates, this.healthRegistry);
  }

  async sendInterrupt(_reason?: string): Promise<void> {
    this.activeHost?.cancel();
    if (this.activeHost) {
      await this.activeHost.waitForSettlement();
    }
  }

  destroy(): void {
    if (this.activeHost) {
      this.activeHost.cancel();
    }
    this.activeHost = null;
    this._isReady = false;
  }

  lastUsage(): RuntimeUsageSnapshot | null {
    return this._lastUsage;
  }

  getRuntimeStatus(): RuntimeStatusSnapshot {
    return {
      route: "pi-ai",
      provider: this.config.candidates[0]?.provider,
      model: this.config.candidates[0]?.model,
      lastTurnUsage: this._lastUsage ?? undefined,
    };
  }
}
