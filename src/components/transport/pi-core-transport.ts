import { logDebug } from "../logger.js";
import type { IKiroTransport, PromptRequestContext, RuntimeUsageSnapshot, RuntimeStatusSnapshot } from "./kiro-transport.js";
import type { CandidateSpec, ModelCandidate } from "./model-candidates.js";
import type { ModelHealthRegistry } from "./model-health-registry.js";
import { FallbackPolicy } from "./fallback-policy.js";
import { PiCoreExecutionHost } from "./pi-core-host.js";
import { PiCoreContextProjection } from "./pi-core-context.js";
import { createPiStreamFn } from "./pi-stream-fn.js";
import { createPiAgentTools } from "./pi-core-tools.js";
import type { PiCoreToolContext } from "./pi-core-tools.js";
import { createPiExecutionSafetyController } from "./pi-core-safety.js";
import type { SandboxPolicy } from "../tool-sandbox.js";
import type { AgentMessage } from "./pi-core-types.js";
import { createCurrentTurnMessage } from "./pi-core-types.js";
import type { OutputObserver } from "../session-output-feed.js";
import type { PiContextOrchestrator } from "./pi-core-context.js";
import { buildPiModel, pickPiApi } from "./pi-ai-adapter.js";
import { candidateKey } from "./model-candidates.js";

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
  contextOrchestrator?: PiContextOrchestrator;
  maxPromptRounds?: number;
  maxCandidateRounds?: number;
}

let executionSeq = 0;

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
  private _isReady = false;
  private _lastUsage: RuntimeUsageSnapshot | null = null;

  /** Override the system prompt for subsequent calls. */
  /** ContextOrchestrator for durable abmind projection. Set by boot composition. */
  get contextOrchestrator(): PiContextOrchestrator | undefined { return this._contextOrchestrator; }
  set contextOrchestrator(value: PiContextOrchestrator | undefined) { this._contextOrchestrator = value; }
  private _contextOrchestrator?: PiContextOrchestrator;
  private _toolCallsSucceeded = 0;
  private _lastResponse = "";
  private _intermediateText = "";

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
    this._contextOrchestrator = opts.contextOrchestrator;
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

  async steer(content: string, lease: import("../spin-types.js").InstructionLease): Promise<string> {
    if (!this.activeHost) throw new Error("No active Pi execution to steer");
    this.activeHost.steer(content, lease);
    await this.activeHost.waitForSettlement();
    return this._lastResponse;
  }

  async followUp(content: string, lease: import("../spin-types.js").InstructionLease): Promise<string> {
    if (!this.activeHost) throw new Error("No active Pi execution for follow-up");
    this.activeHost.followUp(content, lease);
    await this.activeHost.waitForSettlement();
    return this._lastResponse;
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
    // Reset per-call state
    this._lastResponse = "";
    this._intermediateText = "";
    this._toolCallsSucceeded = 0;

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
      context?.beforeMessageId,
    );
    if (image) {
      (currentTurn as { imageContent?: Array<{ mime: string; base64: string }> }).imageContent = [image];
    }

    // Context seed: durable vs ephemeral
    const source = context?.beforeMessageId !== undefined
      ? { mode: "durable" as const, sessionKey, beforeMessageId: context.beforeMessageId, maxContext: this.config.candidates[0]?.maxContext ?? 128000 }
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

    // Build StreamFn — no emergency L0, no legacy conversion
    const streamFn = createPiStreamFn({
      policy: this.policy,
      executionId,
      telemetry: context?.executionTelemetry,
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
    };
    const tools = createPiAgentTools(toolContext);

    // Build context projection with orchestrator when available
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
        orchestrator: context?.orchestrator ?? this._contextOrchestrator,
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

    this.activeHost = host;
    const timeout = this.timeoutOverrideMs;
    const timeoutHandle = timeout && timeout > 0
      ? setTimeout(() => host.cancel(), timeout)
      : undefined;

    try {
      const { loadAndValidatePiAgentCore } = await import("./pi-core-types.js");
      const loaded = await loadAndValidatePiAgentCore();
      await host.start(loaded);
      await host.waitForSettlement();

      if (context?.executionTelemetry) {
        const snap = context.executionTelemetry.snapshot();
        if (snap) this._lastUsage = snap;
      }

      return responseText;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (this.activeHost === host) this.activeHost = null;
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
