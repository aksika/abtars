import { logInfo, logWarn, logDebug } from "../logger.js";
import type { PiAgent, PiAgentOptions, AgentEvent, StreamFn, AgentMessage, LoadedPiAgentCore, ModelApi, BeforeToolCallContext, AgentLoopTurnUpdate } from "./pi-core-types.js";
import { convertMessagesToLlm, createInstructionMessage, PI_AGENT_CORE_CONFIG } from "./pi-core-types.js";
import type { InstructionLease, QueuedSessionInstruction } from "../spin-types.js";
import { markDelivered, markConsumed, failAfterDelivery } from "../session-instruction-queue.js";
import type { InstructionQueueHolder } from "../session-instruction-queue.js";
import type { PiCoreContextProjection, TransformOptions } from "./pi-core-context.js";
import type { PiExecutionSafetyController } from "./pi-core-safety.js";
import type { OutputObserver } from "../session-output-feed.js";
import type { ExecutionTelemetryScope } from "../execution-telemetry.js";

const TAG = "pi-core-host";

export type PiCoreHostState = "created" | "running" | "aborting" | "settling" | "settled";

export interface PiCoreExecutionHostOptions {
  executionId: string;
  sessionId: string;
  initialState: {
    systemPrompt: string;
    model: ModelApi;
    messages: AgentMessage[];
    tools?: import("@earendil-works/pi-agent-core").AgentTool[];
  };
  streamFn: StreamFn;
  session?: { instructionQueue: QueuedSessionInstruction[]; id: string };
  executionTelemetry?: ExecutionTelemetryScope;
  safety?: PiExecutionSafetyController;
  contextProjection?: PiCoreContextProjection;
  transformOptions?: TransformOptions;
  outputObserver?: OutputObserver;
  onEvent?: (event: AgentEvent) => Promise<void> | void;
}

interface OutstandingLease {
  leaseId: string;
  instructions: readonly QueuedSessionInstruction[];
  kind: "steer" | "followUp";
}

export class PiCoreExecutionHost {
  readonly executionId: string;
  readonly sessionId: string;
  state: PiCoreHostState = "created";
  private agent: PiAgent | null = null;
  private unsub: (() => void) | null = null;
  private settled = false;
  private settlementPromise: Promise<void> | null = null;
  private settlementResolve: (() => void) | null = null;
  private idlePromise: Promise<void> | null = null;
  private outstandingLeases: Map<string, OutstandingLease> = new Map();
  private opts: PiCoreExecutionHostOptions;
  private outputObserver?: OutputObserver;

  constructor(opts: PiCoreExecutionHostOptions) {
    this.executionId = opts.executionId;
    this.sessionId = opts.sessionId;
    this.opts = opts;
    this.outputObserver = opts.outputObserver;
    logDebug(TAG, `Host created for execution ${this.executionId} (session ${this.sessionId})`);
  }

  async start(loaded: LoadedPiAgentCore): Promise<void> {
    if (this.state !== "created") {
      throw new Error(`Cannot start host in state ${this.state}`);
    }

    const systemPrompt = this.opts.contextProjection
      ? this.opts.contextProjection.buildSystemPromptFromSeed()
      : this.opts.initialState.systemPrompt;

    // batch convertToLlm matching real Pi contract: (messages: AgentMessage[]) => Message[]
    const convertToLlm = (messages: AgentMessage[]): import("@earendil-works/pi-ai").Message[] => {
      return convertMessagesToLlm(messages);
    };

    const transformContext = async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
      if (!this.opts.contextProjection) return [...messages];

      if (this.opts.safety && signal) {
        const candidateKey = this.opts.transformOptions?.candidateKeyFn?.() ?? this.executionId;
        const turnDecision = this.opts.safety.beginProviderTurn(candidateKey);
        if (turnDecision.decision === "stop") {
          logDebug(TAG, `Provider turn stopped: ${turnDecision.reason}`);
          // Candidate limits are handled by pi-stream-fn after the policy
          // excludes that candidate. A prompt-wide stop must prevent the
          // provider request from being issued at all.
          if (turnDecision.reason?.startsWith("Prompt round limit") || this.opts.safety.stopped) {
            this.opts.safety.requestStop(turnDecision.reason ?? "Provider turn stopped");
            throw new Error(turnDecision.reason ?? "Provider turn stopped");
          }
        } else if (turnDecision.decision === "pause") {
          logDebug(TAG, "Provider turn paused");
          this.opts.safety.requestPause();
          throw new Error("Provider turn paused");
        }
      }

      const cleanMessages = this.opts.safety
        ? this.opts.safety.scrubClassifiedLiterals(messages)
        : [...messages];

      const transformOptions: TransformOptions = {
        ...(this.opts.transformOptions ?? { hostGeneration: 0 }),
        signal: this.opts.transformOptions?.signal ?? signal,
      };
      const result = await this.opts.contextProjection.transform(cleanMessages, transformOptions);
      if (this.outputObserver && result.contextDegraded) {
        this.notifyOutput(() => this.outputObserver?.end?.("error"));
      }
      return result.messages;
    };

    // Pi owns the system prompt separately. The current user turn and any
    // execution-local suffix enter through prompt() exactly once.
    const agentOptions: PiAgentOptions = {
      initialState: {
        systemPrompt,
        model: this.opts.initialState.model,
        messages: [],
        tools: [...(this.opts.initialState.tools ?? [])],
      },
      streamFn: this.opts.streamFn,
      steeringMode: PI_AGENT_CORE_CONFIG.steeringMode,
      followUpMode: PI_AGENT_CORE_CONFIG.followUpMode,
      toolExecution: PI_AGENT_CORE_CONFIG.toolExecution,
      convertToLlm,
      transformContext,
      beforeToolCall: async (_context: BeforeToolCallContext, signal?: AbortSignal) => {
        if (signal?.aborted || this.opts.safety?.paused || this.opts.safety?.stopped) {
          return { block: true, reason: signal?.aborted ? "Execution cancelled" : "Execution paused or stopped" };
        }
        return undefined;
      },
      afterToolCall: async () => undefined,
      prepareNextTurnWithContext: async (ctx, signal): Promise<AgentLoopTurnUpdate | undefined> => {
        if (!this.opts.safety) return undefined;
        if (signal?.aborted) return undefined;
        const candidateKey = this.opts.transformOptions?.candidateKeyFn?.() ?? this.executionId;
        return this.opts.safety.prepareNextTurn({
          candidateKey,
          roundsUsed: this.opts.safety.promptRoundsUsed,
          maxRounds: this.opts.safety.maxPromptRounds,
          incident: this.opts.safety.incident,
          context: ctx.context,
          modelForCandidate: this.opts.transformOptions?.candidateModelFn,
        });
      },
    };

    try {
      this.agent = new loaded.module.Agent(agentOptions);
    } catch (err) {
      this.settle();
      throw err;
    }

    // subscribe returns the promise so Pi awaits it — matches real contract
    this.unsub = this.agent.subscribe((event: AgentEvent, signal?: AbortSignal) => {
      return this.handleEvent(event, signal);
    });

    this.state = "running";
    this.settlementPromise = new Promise((resolve) => { this.settlementResolve = resolve; });

    // Send the actual user/current-turn messages via prompt(), not via state.
    const userMessages = [...this.opts.initialState.messages];
    if (userMessages.length > 0) {
      try {
        await this.agent.prompt(userMessages);
      } catch (err) {
        if (this.state !== "running") {
          logDebug(TAG, `Prompt interrupted during startup (state=${this.state}): ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        logWarn(TAG, `Initial prompt failed: ${err instanceof Error ? err.message : String(err)}`);
        this.beginSettle("prompt_failure");
      }
    }
  }

  // Cross-instance executionId deduplication is a #1446/#1447 production concern.

  private ensureSession(): InstructionQueueHolder | null {
    const s = this.opts.session;
    if (!s) return null;
    return s;
  }

  steer(content: string, lease: InstructionLease): void {
    if (this.state !== "running" && this.state !== "created") {
      logDebug(TAG, `Cannot steer in state ${this.state}`);
      return;
    }
    if (this.outstandingLeases.size > 0) {
      logWarn(TAG, `Cannot steer — outstanding lease ${this.outstandingLeases.keys().next().value} not yet consumed`);
      return;
    }
    const msg = createInstructionMessage(
      content,
      lease.leaseId,
      lease.instructions.map((i) => i.id),
      this.executionId,
      "steer",
    );
    this.outstandingLeases.set(lease.leaseId, {
      leaseId: lease.leaseId,
      instructions: lease.instructions,
      kind: "steer",
    });
    const session = this.ensureSession();
    if (session) markDelivered(lease);
    try {
      if (!this.agent) throw new Error("Cannot steer before Agent construction");
      this.agent.steer(msg);
    } catch (err) {
      logWarn(TAG, `steer() threw before queue insertion: ${err instanceof Error ? err.message : String(err)}`);
      this.outstandingLeases.delete(lease.leaseId);
      if (session) failAfterDelivery(lease, session, "steer_handoff_failed");
      throw err;
    }
  }

  followUp(content: string, lease: InstructionLease): void {
    if (this.state !== "running" && this.state !== "created") {
      logDebug(TAG, `Cannot followUp in state ${this.state}`);
      return;
    }
    if (this.outstandingLeases.size > 0) {
      logWarn(TAG, `Cannot followUp — outstanding lease ${this.outstandingLeases.keys().next().value} not yet consumed`);
      return;
    }
    const msg = createInstructionMessage(
      content,
      lease.leaseId,
      lease.instructions.map((i) => i.id),
      this.executionId,
      "followUp",
    );
    this.outstandingLeases.set(lease.leaseId, {
      leaseId: lease.leaseId,
      instructions: lease.instructions,
      kind: "followUp",
    });
    const session = this.ensureSession();
    if (session) markDelivered(lease);
    try {
      if (!this.agent) throw new Error("Cannot followUp before Agent construction");
      this.agent.followUp(msg);
    } catch (err) {
      logWarn(TAG, `followUp() threw before queue insertion: ${err instanceof Error ? err.message : String(err)}`);
      this.outstandingLeases.delete(lease.leaseId);
      if (session) failAfterDelivery(lease, session, "followup_handoff_failed");
      throw err;
    }
  }

  cancel(): void {
    if (this.state === "settled") return;
    if (this.state === "created") {
      this.settle();
      return;
    }
    this.state = "aborting";
    this.agent?.abort();
    this.beginSettle("cancelled");
  }

  private beginSettle(reason: string): void {
    if (this.state === "settling" || this.state === "settled") return;
    this.state = "settling";
    logDebug(TAG, `Settling host for execution ${this.executionId}: ${reason}`);
    this.settle(reason);
  }

  private settle(reason?: string): void {
    if (this.settled) return;
    this.settled = true;
    this.state = "settled";

    this.unsub?.();
    this.unsub = null;

    this.agent?.clearAllQueues();

    const session = this.ensureSession();
    for (const [, lease] of this.outstandingLeases) {
      const fakeLease: InstructionLease = {
        leaseId: lease.leaseId,
        sessionId: this.sessionId,
        executionId: this.executionId,
        kind: lease.kind,
        instructions: lease.instructions as InstructionLease["instructions"],
      };
      if (session) failAfterDelivery(fakeLease, session, "host_settled");
    }
    this.outstandingLeases.clear();

    this.idlePromise = this.waitForIdleCleanup();

    this.settlementResolve?.();
    this.settlementPromise = null;

    if (this.outputObserver) {
      if (reason === "cancelled") {
        this.notifyOutput(() => this.outputObserver?.end?.("cancelled"));
      } else if (reason && reason !== "agent_end") {
        this.notifyOutput(() => this.outputObserver?.end?.("error"));
      } else {
        this.notifyOutput(() => this.outputObserver?.end?.("complete"));
      }
    }

    logInfo(TAG, `Host settled for execution ${this.executionId}`);
  }

  private async waitForIdleCleanup(): Promise<void> {
    if (!this.agent) return;
    try {
      await this.agent.waitForIdle();
    } catch (err) {
      logDebug(TAG, `waitForIdle completed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleEvent(event: AgentEvent, _signal?: AbortSignal): Promise<void> {
    if (this.settled) return;

    if (event.type === "message_end") {
      this.handleMessageEnd(event.message);
    } else if (event.type === "agent_end") {
      this.handleAgentEnd(event);
    }

    // Map real Pi events to output observers
    if (event.type === "message_update") {
      const streamEv = event.assistantMessageEvent as { type?: string; delta?: string } | null;
      if (streamEv?.type === "text_delta" && streamEv.delta) {
        this.notifyOutput(() => this.outputObserver?.onDelta?.({ kind: "text", text: streamEv.delta as string }));
      }
      if (streamEv?.type === "thinking_delta" && streamEv.delta) {
        this.notifyOutput(() => this.outputObserver?.onDelta?.({ kind: "thinking", text: streamEv.delta as string }));
      }
    } else if (event.type === "tool_execution_start") {
      this.notifyOutput(() => this.outputObserver?.onToolStart?.({ name: event.toolName }));
    }

    try {
      await this.opts.onEvent?.(event);
    } catch (err) {
      logWarn(TAG, `Output observer threw (isolated): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private handleMessageEnd(message: AgentMessage): void {
    if (message.role !== "abtars_instruction") return;
    const instruction = message;
    const outstanding = this.outstandingLeases.get(instruction.leaseId);
    if (!outstanding || instruction.executionId !== this.executionId || instruction.kind !== outstanding.kind) return;
    const expectedIds = outstanding.instructions.map((item) => item.id);
    if (expectedIds.length !== instruction.instructionIds.length || expectedIds.some((id) => !instruction.instructionIds.includes(id))) return;

    const session = this.ensureSession();
    if (session) {
      const lease: InstructionLease = {
        leaseId: outstanding.leaseId,
        sessionId: this.sessionId,
        executionId: this.executionId,
        kind: outstanding.kind,
        instructions: outstanding.instructions as InstructionLease["instructions"],
      };
      markConsumed(lease, session);
    }
    this.outstandingLeases.delete(outstanding.leaseId);
  }

  private handleAgentEnd(_event: Extract<AgentEvent, { type: "agent_end" }>): void {
    logInfo(TAG, `Agent ended for execution ${this.executionId}`);
    this.beginSettle("agent_end");
  }

  private notifyOutput(action: () => void): void {
    try {
      action();
    } catch (err) {
      logWarn(TAG, `Output observer failed (isolated): ${err instanceof Error ? err.name : "unknown"}`);
    }
  }

  async waitForSettlement(): Promise<void> {
    if (this.idlePromise) {
      await this.idlePromise;
    } else if (this.agent) {
      await this.agent.waitForIdle();
    }
    if (this.settlementPromise) {
      await this.settlementPromise;
    }
  }

  get isRunning(): boolean {
    return this.state === "running" && (this.agent?.state.isStreaming ?? false);
  }

  get isSettled(): boolean {
    return this.settled;
  }
}
