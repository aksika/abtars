import { logDebug } from "../logger.js";
import type { IKiroTransport, PromptRequestContext, RuntimeUsageSnapshot, RuntimeStatusSnapshot } from "./kiro-transport.js";
import type { ModelCandidate } from "./model-candidates.js";
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

const TAG = "pi-core-transport";

export interface PiCoreTransportOptions {
  role: "main" | "specialist" | "background" | "task";
  systemPrompt: string;
  candidates: ModelCandidate[];
  healthRegistry: ModelHealthRegistry;
  sandboxPolicy: SandboxPolicy;
  session?: { instructionQueue: Array<import("../spin-types.js").QueuedSessionInstruction>; id: string };
}

let executionSeq = 0;

export class PiCoreTransport implements IKiroTransport {
  readonly config: { candidates: ModelCandidate[]; systemPrompt: string; role: string };
  private policy: FallbackPolicy;
  private healthRegistry: ModelHealthRegistry;
  private sandboxPolicy: SandboxPolicy;
  private session?: PiCoreTransportOptions["session"];
  private activeHost: PiCoreExecutionHost | null = null;
  private _isReady = false;
  private _lastUsage: RuntimeUsageSnapshot | null = null;
  private _toolCallsSucceeded = 0;
  private _lastResponse = "";
  private _intermediateText = "";

  onReady?: () => void;
  onIntermediateResponse?: (text: string) => void;
  onToolCallStart?: (toolName: string) => void;
  onSegmentBreak?: (text: string) => void;

  constructor(opts: PiCoreTransportOptions) {
    this.config = { candidates: opts.candidates, systemPrompt: opts.systemPrompt, role: opts.role };
    this.healthRegistry = opts.healthRegistry;
    this.sandboxPolicy = opts.sandboxPolicy;
    this.session = opts.session;
    this.policy = new FallbackPolicy(opts.candidates, opts.healthRegistry);
  }

  get isReady(): boolean { return this._isReady; }
  get contextPercent(): number { return -1; }
  get answerOnly(): string { return this._lastResponse; }
  get toolCallsSucceeded(): number { return this._toolCallsSucceeded; }
  get intermediateDeliveredText(): string { return this._intermediateText; }
  get transportCommands(): string[] { return []; }

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

    const safety = createPiExecutionSafetyController(this.policy);

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
    const source = context?.beforeMessageId
      ? { mode: "durable" as const, sessionKey, beforeMessageId: context.beforeMessageId, maxContext: this.config.candidates[0]?.maxContext ?? 128000 }
      : { mode: "ephemeral" as const, sessionKey };

    const volatileBlocks: Array<{ kind: string; content: string }> = [];
    if (context?.directContextTurn?.volatileBlocks) {
      volatileBlocks.push(...context.directContextTurn.volatileBlocks);
    }

    const systemPrompt = this.config.systemPrompt;

    // Build the Pi model
    const first = this.config.candidates[0];
    const piModel = {
      id: first?.model ?? "unknown",
      name: first?.model ?? "unknown",
      api: "openai-completions" as const,
      provider: first?.provider ?? "unknown",
      baseUrl: first?.endpoint ?? "",
      reasoning: false,
      input: ["text"] as Array<"text" | "image">,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: first?.maxContext ?? 128000,
      maxTokens: 4096,
    };

    // Build StreamFn — no emergency L0, no legacy conversion
    const streamFn = createPiStreamFn({
      policy: this.policy,
      telemetry: context?.executionTelemetry,
      onCandidateCommitted: (candidate) => {
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
        orchestrator: (context as Record<string, unknown>).orchestrator as {
          getContext(s: string, m: number, o: { beforeMessageId?: number }): Promise<{ messages: Array<{ role: string; content: string }> }>;
        } | undefined,
      },
      outputObserver,
      onEvent: (event) => {
        if (event.type === "tool_execution_start") {
          this.onToolCallStart?.(event.toolName);
        }
        if (event.type === "message_end") {
          const msg = event.message as unknown as { content?: string };
          responseText = msg.content ?? "";
          this._lastResponse = msg.content ?? "";
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

    const { loadAndValidatePiAgentCore } = await import("./pi-core-types.js");
    const loaded = await loadAndValidatePiAgentCore();

    try {
      await host.start(loaded);
    } catch (err) {
      this.activeHost = null;
      throw err;
    }

    await host.waitForSettlement();

    if (context?.executionTelemetry) {
      const snap = context.executionTelemetry.snapshot();
      if (snap) this._lastUsage = snap;
    }

    this.activeHost = null;

    return responseText || "OK";
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
