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
  session?: { instructionQueue: Array<{ id: string; sessionId: string; executionId: string; kind: import("../spin-types.js").ExecutionInstructionKind; text: string; state: import("../spin-types.js").ExecutionInstructionState; source: import("../spin-types.js").QueuedSessionInstruction["source"]; bytes: number; createdAt: number }>; id: string };
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
  get answerOnly(): string { return ""; }
  get toolCallsSucceeded(): number { return this._toolCallsSucceeded; }
  get intermediateDeliveredText(): string { return ""; }
  get transportCommands(): string[] { return []; }

  async initialize(): Promise<void> {
    this._isReady = true;
    this.onReady?.();
  }

  async sendPrompt(
    sessionKey: string,
    message: string,
    _image?: { mime: string; base64: string },
    context?: PromptRequestContext,
  ): Promise<string> {
    const executionId = `${sessionKey}_${Date.now()}_${++executionSeq}`;
    const safety = createPiExecutionSafetyController(this.policy);

    // Build current-turn marker
    const currentTurn = createCurrentTurnMessage(message, executionId, sessionKey, context?.beforeMessageId);

    // Build context seed: durable vs ephemeral
    const source = context?.beforeMessageId
      ? { mode: "durable" as const, sessionKey, beforeMessageId: context.beforeMessageId, maxContext: 128000 }
      : { mode: "ephemeral" as const, sessionKey };

    const volatileBlocks: Array<{ kind: string; content: string }> = [];
    if (context?.directContextTurn?.volatileBlocks) {
      volatileBlocks.push(...context.directContextTurn.volatileBlocks);
    }

    const systemPrompt = this.config.systemPrompt;

    // Build the Pi model and StreamFn
    const piModel = {
      id: this.config.candidates[0]?.model ?? "unknown",
      name: this.config.candidates[0]?.model ?? "unknown",
      api: "openai-completions" as const,
      provider: this.config.candidates[0]?.provider ?? "unknown",
      baseUrl: this.config.candidates[0]?.endpoint ?? "",
      reasoning: false,
      input: ["text"] as Array<"text" | "image">,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: this.config.candidates[0]?.maxContext ?? 128000,
      maxTokens: 4096,
    };

    const streamFn = createPiStreamFn({
      policy: this.policy,
      telemetry: context?.executionTelemetry,
      onCandidateCommitted: (candidate) => {
        logDebug(TAG, `Candidate committed: ${candidate.model}`);
      },
    });

    // Build tools
    const toolContext: PiCoreToolContext = {
      executionId,
      userId: context?.userId ?? "unknown",
      signal: undefined,
      sandboxPolicy: this.sandboxPolicy,
      safety,
    };
    const tools = createPiAgentTools(toolContext);

    // Build context projection
    const contextProjection = new PiCoreContextProjection(
      { source, executionId, currentTurn, volatileBlocks },
      systemPrompt,
    );

    // Build host messages: system prompt + current turn (with identity marker)
    const hostMessages: AgentMessage[] = [
      currentTurn as unknown as AgentMessage,
    ];

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
      outputObserver,
      onEvent: (event) => {
        if (event.type === "tool_execution_start") {
          this.onToolCallStart?.(event.toolName);
        }
        if (event.type === "message_update") {
          const streamEv = event.assistantMessageEvent as { type?: string; delta?: string } | null;
          if (streamEv?.type === "text_delta" && streamEv.delta) {
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

    // Load Pi and start
    const { loadAndValidatePiAgentCore } = await import("./pi-core-types.js");
    const loaded = await loadAndValidatePiAgentCore();

    try {
      await host.start(loaded);
    } catch (err) {
      this.activeHost = null;
      throw err;
    }

    // Wait for agent settlement
    await host.waitForSettlement();

    // Collect usage from telemetry
    if (context?.executionTelemetry) {
      const snap = context.executionTelemetry.snapshot();
      if (snap) {
        this._lastUsage = snap;
      }
    }

    this._toolCallsSucceeded = 0;
    this.activeHost = null;

    return "OK";
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

  getActiveSession?(): null { return null; }
  healthCheck?(): Promise<void> { return Promise.resolve(); }
  executeCommand?(_cmd: string): Promise<string> { return Promise.resolve(""); }
}
