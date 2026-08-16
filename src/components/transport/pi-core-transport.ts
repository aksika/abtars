import { logDebug, logInfo, logWarn } from "../logger.js";
import type { IKiroTransport, PromptRequestContext, ReasoningEffort, ReasoningEffortState, RuntimeUsageSnapshot, RuntimeStatusSnapshot } from "./kiro-transport.js";
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
import { createCurrentTurnMessage, PiCoreContractError } from "./pi-core-types.js";
import type { OutputObserver } from "../session-output-feed.js";
import type { DurableContextProviderHolder } from "./pi-core-context.js";
import { resolveCandidateModel } from "./pi-ai-adapter.js";
import { candidateKey } from "./model-candidates.js";
import { PiCoreToolExecutionError, buildTerminalDiagnostic } from "./tool-failure-diagnostic.js";
import type { ToolFailureDiagnosticV1 } from "./tool-failure-diagnostic.js";
import { ProviderExecutionError } from "./provider-failure.js";
import type { ProviderTerminalFailure } from "./provider-failure.js";

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

/** #1619: true when an assistant message content array carries a tool call. */
export function hasToolCallContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "toolCall",
  );
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
  /** #1552: late-bound memory-tool dependencies holder (runtime + quota). */
  memoryToolDeps?: import("../memory-store-quota.js").MemoryToolDependenciesHolder;
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
  /** #1573: shared in-flight initialization probe; cleared after settlement. */
  private _initializing: Promise<void> | null = null;

  /** #1527: late-bound durable context provider; populated once memory is ready. */
  private _contextProvider: DurableContextProviderHolder;
  /** #1552: late-bound memory-tool dependencies; read per execution. */
  private _memoryToolDeps: import("../memory-store-quota.js").MemoryToolDependenciesHolder;
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
  onSegmentBreak?: (text: string) => void | Promise<void>;
  /** #1619: typed live output deltas (text + thinking) for shared consumers. */
  onOutputDelta?: (event: import("./kiro-transport.js").OutputDelta) => void;

  /** #1619: session-scoped requested reasoning effort (survives reset/fallback). */
  private requestedEffort: ReasoningEffort;
  /** #1619: effective level from Pi clamping — the last candidate commit wins. */
  private effectiveEffort: ReasoningEffort;
  /** #1619: candidate that actually committed this session (owns live status). */
  private committedCandidate: CandidateSpec | null = null;
  /** #1619: context tokens measured from the last valid assistant usage. */
  private currentContextTokens: number | null = null;
  /** #1619: context window paired with the committed candidate. */
  private currentContextWindow: number | null = null;

  constructor(opts: PiCoreTransportOptions) {
    this.config = { candidates: opts.candidates, systemPrompt: opts.systemPrompt, role: opts.role };
    this.healthRegistry = opts.healthRegistry;
    this.sandboxPolicy = opts.sandboxPolicy;
    this.session = opts.session;
    this._contextProvider = opts.contextProvider ?? { current: null };
    this._memoryToolDeps = opts.memoryToolDeps ?? { current: null };
    this.maxPromptRounds = opts.maxPromptRounds;
    this.maxCandidateRounds = opts.maxCandidateRounds;
    this.policy = new FallbackPolicy(opts.candidates, opts.healthRegistry);
    // #1619: baseline from the primary candidate's effort-style config; a
    // transport without one starts at Pi's truthful headless baseline.
    const primary = opts.candidates[0];
    this.requestedEffort = primary?.thinking?.style === "effort"
      ? primary.thinking.default
      : "off";
    // The configured default is subject to the same Pi capability clamp as a
    // live `/effort` change. Without this, status can claim xhigh before the
    // first turn even though the initial model will actually run at high.
    this.effectiveEffort = primary
      ? resolveCandidateModel(primary, this.requestedEffort, false).effective
      : this.requestedEffort;
  }

  get isReady(): boolean { return this._isReady; }
  /** #1619: live measured context percentage (0-100) or -1 when unknown. */
  get contextPercent(): number {
    const snapshot = this.getRuntimeStatus();
    if (snapshot.contextPercent !== undefined && snapshot.contextPercent >= 0) {
      return Math.round(snapshot.contextPercent * 10) / 10;
    }
    return -1;
  }
  get answerOnly(): string { return this._lastResponse; }
  get toolCallsSucceeded(): number { return this._toolCallsSucceeded; }
  get intermediateDeliveredText(): string { return this._intermediateText; }
  get transportCommands(): string[] { return []; }

  /**
   * #1619: change the attached session's reasoning effort. Resolves the
   * request against the primary Pi model's clamping semantics, stores the
   * effective level, and returns both. Never reaches into an active host, so
   * an in-flight provider request remains unchanged; the next turn carries it.
   */
  setReasoningEffort(level: ReasoningEffort): ReasoningEffortState {
    this.requestedEffort = level;
    const primary = this.config.candidates[0];
    if (!primary) {
      this.effectiveEffort = level;
      return { requested: level, effective: level };
    }
    const resolved = resolveCandidateModel(primary, level, false);
    this.effectiveEffort = resolved.effective;
    return { requested: level, effective: resolved.effective };
  }

  /** #1619: clear measured context usage (reset/compaction). */
  invalidateContextUsage(): void {
    this.currentContextTokens = null;
  }

  /** #1619: resolve a candidate's model with the session's requested effort. */
  private resolveModel(
    candidate: Parameters<typeof resolveCandidateModel>[0],
    hasImage: boolean,
  ) {
    return resolveCandidateModel(candidate, this.requestedEffort, hasImage);
  }

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
    this.effectiveEffort = resolveCandidateModel(primary, this.requestedEffort, false).effective;
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
    // The rejection itself is observed by the caller awaiting the slot's host.
    void hostReady.catch(() => { /* rejection is observed by the slot caller; this pre-attached handler only prevents unhandled-rejection surfacing */ });
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

  /**
   * #1573: single readiness gate. Probes the complete executable runtime
   * contract (agent-core methods, pi-ai createProvider, every configured API
   * family) before `_isReady` flips or `onReady` fires. A rejection leaves the
   * transport unready with no cached verdict, so a later explicit
   * initialization after the operator repairs Pi probes again. Concurrent
   * callers share one in-flight probe.
   */
  async initialize(): Promise<void> {
    if (this._isReady) return;
    if (!this._initializing) {
      this._initializing = this.runInitialization().finally(() => {
        this._initializing = null;
      });
    }
    return this._initializing;
  }

  private async runInitialization(): Promise<void> {
    const { validatePiRuntimeContract } = await import("./pi-runtime-contract.js");
    await validatePiRuntimeContract(this.config.candidates);
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
      // #1297: terminal-failure state is allocated per execution — a previous
      // request's credit failure can never contaminate a later request.
      const executionState: { terminalFailure: ProviderTerminalFailure | null } = { terminalFailure: null };

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
        return this.resolveModel(candidate, Boolean(image)).model;
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
        ? this.resolveModel(first, Boolean(image)).model
        : resolveCandidateModel({ model: "unknown", endpoint: "", maxContext: 128000, provider: "unknown" }, this.requestedEffort, Boolean(image)).model;

      const timeoutOverride = this.timeoutOverrideMs;
      const deadlineAt = context?.deadlineAt
        ?? (timeoutOverride && timeoutOverride > 0 ? Date.now() + timeoutOverride : undefined);

      // Build StreamFn — no emergency L0, no legacy conversion
      const streamFn = createPiStreamFn({
        policy: this.policy,
        executionId,
        telemetry: context?.executionTelemetry,
        deadlineAt,
        providerInactivityTimeoutMs: context?.providerInactivityTimeoutMs ?? 180_000,
        reasoningEffort: this.requestedEffort,
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
          // #1619: the candidate that actually commits owns live provider/model/
          // window/effective-effort state. Fallback preserves the requested
          // level, not the prior candidate's clamped effective level.
          this.committedCandidate = successful;
          const resolved = this.resolveModel(candidate, Boolean(image));
          this.effectiveEffort = resolved.effective;
          this.currentContextWindow = candidate.maxContext;
          logDebug(TAG, `Candidate committed: ${candidate.model} (effort: ${this.requestedEffort} → ${resolved.effective})`);
        },
        onTerminalFailure: (failure) => {
          executionState.terminalFailure = failure;
          logDebug(TAG, `sendPrompt: terminal provider failure ${failure.code} (${failure.attemptedCandidates} candidates attempted)`);
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
        sessionType: context?.sessionType,
        memoryToolDeps: this._memoryToolDeps,
        // #1629: trusted per-execution tool authorization mode.
        authorizationMode: context?.authorizationMode,
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
          // #1619: the clamped effective level for the initial model; Pi Agent
          // turns it into the first request's reasoning option.
          thinkingLevel: this.resolveModel(first ?? { model: "unknown", endpoint: "", maxContext: 128000, provider: "unknown" }, Boolean(image)).effective,
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
        // #1619: pair every safety-selected replacement model with a fresh
        // effective thinking level derived from the session's requested effort.
        resolveThinkingLevelForModel: (model) => {
          const candidate = this.config.candidates.find(
            (item) => candidateKey(item.model, item.endpoint) === candidateKey(model.id, model.baseUrl ?? model.provider),
          ) ?? this.config.candidates.find((item) => item.model === model.id);
          const source = candidate ?? {
            model: model.id,
            provider: model.provider ?? "unknown",
            endpoint: model.baseUrl ?? "",
            maxContext: this.currentContextWindow ?? this.config.candidates[0]?.maxContext ?? 128000,
          };
          return this.resolveModel(source, Boolean(image)).effective;
        },
        onEvent: async (event) => {
          if (event.type === "tool_execution_start") {
            this.onToolCallStart?.(event.toolName);
          }
          if (event.type === "message_end") {
            const msg = event.message as unknown as { role?: string; content?: unknown };
            if (msg.role === "assistant") {
              const text = extractAssistantText(msg.content);
              responseText = text;
              this._lastResponse = text;
              // #1619: complete user-visible assistant text before a tool
              // round is delivered before tool execution continues. Only tool-
              // carrying messages are semantic segments — awaited so the
              // platform pipeline can reconcile before the tool status lands.
              // An interim send failure never rejects the model turn.
              if (hasToolCallContent(msg.content) && text) {
                try {
                  await this.onSegmentBreak?.(text);
                } catch (err) {
                  logWarn(TAG, `Segment break delivery failed (isolated): ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }
          }
          if (event.type === "message_update") {
            const streamEv = event.assistantMessageEvent as { type?: string; delta?: string } | null;
            if (streamEv?.type === "text_delta" && streamEv.delta) {
              this._intermediateText += streamEv.delta;
              this.onIntermediateResponse?.(streamEv.delta);
              this.onOutputDelta?.({ kind: "text", text: streamEv.delta });
            }
            if (streamEv?.type === "thinking_delta" && streamEv.delta) {
              this.onOutputDelta?.({ kind: "thinking", text: streamEv.delta });
            }
          }
          if (event.type === "tool_execution_end" && !event.isError) {
            this._toolCallsSucceeded++;
          }
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
        // #1622: the typed reason distinguishes normal completion from a Pi
        // lifecycle contract violation (prompt returned with no agent_end).
        const terminalReason = await host.waitForSettlement();
        slot.settled = true;

        // #1622: a resolved prompt without a terminal agent_end is a Pi
        // contract violation — the turn never actually settled. Lead with the
        // contract error before any response/tool/provider outcome selection;
        // never report this as a successful empty answer. A prior tool failure
        // is retained as supporting cause only.
        if (terminalReason === "prompt_completed_without_agent_end") {
          logWarn(TAG, `sendPrompt: prompt completed without agent_end (${executionId}) — contract error`);
          throw new PiCoreContractError(
            "pi-agent-core prompt completed without agent_end",
            {
              missingCapability: "agent_end settlement",
              cause: this._lastToolFailure
                ? new PiCoreToolExecutionError(this._lastToolFailure)
                : undefined,
            },
          );
        }

        if (context?.executionTelemetry) {
          const snap = context.executionTelemetry.snapshot();
          if (snap) this._lastUsage = snap;
        }
        // #1612: prefer the host's captured assistant-message usage (real
        // provider tokens) over the telemetry scope, which pi-core never
        // populates with token counts.
        const hostUsage = host.lastUsage;
        if (hostUsage) {
          this._lastUsage = hostUsage;
        }
        // #1619: pair the current-context token measurement with the window of
        // the candidate that actually committed. Only valid usage counts.
        const contextTokens = host.lastContextTokens;
        if (contextTokens !== null && contextTokens > 0) {
          this.currentContextTokens = contextTokens;
          this.currentContextWindow = this.committedCandidate?.maxContext
            ?? this.config.candidates[0]?.maxContext
            ?? null;
          logDebug(TAG, `Context usage captured: ${contextTokens} tokens / ${this.currentContextWindow ?? "?"} window`);
        }

        // #1595: the terminal cause leads; a prior tool failure is supporting
        // context only. Never present a stale tool failure as the primary
        // reason, and never report candidate_exhausted:true for a run that
        // continued past rotation (sole-candidate or switched) and ended for
        // another reason.
        if (safety.terminalSafetyFailure && safety.lastTerminalIncident) {
          const inc = safety.lastTerminalIncident;
          logInfo(TAG, `sendPrompt: terminal safety incident (${inc.type}) — leading with terminal cause, prior tool failure retained as context`);
          throw new PiCoreToolExecutionError(buildTerminalDiagnostic(executionId, inc, this._lastToolFailure ?? undefined));
        }

        if (responseText.trim() !== "") {
          logDebug(TAG, `sendPrompt: returning ${responseText.length}ch assistant text`);
          return responseText;
        }

        if (this._lastToolFailure) {
          logInfo(TAG, `sendPrompt: empty response with terminal tool failure — throwing diagnostic`);
          throw new PiCoreToolExecutionError(this._lastToolFailure);
        }

        // #1297: a committed successful output and a terminal tool failure
        // already took precedence; only now does a typed terminal provider
        // failure surface as a non-retryable error. No typed failure → current
        // generic empty-response behavior.
        if (executionState.terminalFailure) {
          logInfo(TAG, `sendPrompt: throwing ProviderExecutionError (${executionState.terminalFailure.code})`);
          throw new ProviderExecutionError(executionState.terminalFailure);
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
    // #1619: reset/compaction invalidates measured usage; requested effort
    // survives on the same transport instance.
    this.currentContextTokens = null;
    this.currentContextWindow = null;
    this.committedCandidate = null;
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
    this.committedCandidate = null;
    this.currentContextTokens = null;
    this.currentContextWindow = null;
  }

  lastUsage(): RuntimeUsageSnapshot | null {
    return this._lastUsage;
  }

  getRuntimeStatus(): RuntimeStatusSnapshot {
    const live = this.committedCandidate
      ?? this.config.candidates[0] ?? null;
    const contextWindow = this.currentContextWindow ?? live?.maxContext ?? undefined;
    const tokens = this.currentContextTokens;
    let contextPercent: number | undefined;
    if (tokens !== null && tokens > 0 && contextWindow !== undefined && contextWindow > 0) {
      contextPercent = Math.min(100, Math.max(0, (tokens / contextWindow) * 100));
    }
    const snapshot: RuntimeStatusSnapshot = {
      route: "pi-ai",
      provider: live?.provider,
      model: live?.model,
      contextWindow,
      contextPercent,
      reasoning: this.effectiveEffort,
      lastTurnUsage: this._lastUsage ?? undefined,
    };
    if (this.effectiveEffort !== this.requestedEffort) {
      snapshot.reasoningRequested = this.requestedEffort;
    }
    return snapshot;
  }
}
