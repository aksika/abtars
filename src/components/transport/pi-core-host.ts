import { logInfo, logWarn, logDebug } from "../logger.js";
import type { PiAgent, PiAgentOptions, AgentEvent, AssistantMessage, StreamFn, AgentMessage, LoadedPiAgentCore } from "./pi-core-types.js";
import { convertInstructionToLlm, convertCurrentTurnToLlm, createInstructionMessage, PI_AGENT_CORE_CONFIG } from "./pi-core-types.js";
import type { ExecutionTelemetryScope } from "../execution-telemetry.js";
import type { InstructionLease, QueuedSessionInstruction } from "../spin-types.js";
import { markDelivered, markConsumed, failAfterDelivery } from "../session-instruction-queue.js";
import type { ManagedSession } from "../spin-types.js";
import type { PiCoreContextProjection, TransformOptions } from "./pi-core-context.js";
import type { PiExecutionSafetyController } from "./pi-core-safety.js";
import type { OutputObserver } from "../session-output-feed.js";

const TAG = "pi-core-host";

export type PiCoreHostState = "created" | "running" | "aborting" | "settling" | "settled";

export interface PiCoreExecutionHostOptions {
  executionId: string;
  sessionId: string;
  initialState: {
    systemPrompt: string;
    model: unknown;
    messages: readonly AgentMessage[];
    tools?: readonly unknown[];
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
  private telemetry?: ExecutionTelemetryScope;
  private outputObserver?: OutputObserver;

  constructor(opts: PiCoreExecutionHostOptions) {
    this.executionId = opts.executionId;
    this.sessionId = opts.sessionId;
    this.opts = opts;
    this.telemetry = opts.executionTelemetry;
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
    const convertToLlm = (messages: readonly AgentMessage[]): readonly AgentMessage[] => {
      return messages.map((m) => {
        if (m.role === "abtars_instruction") return convertInstructionToLlm(m);
        if (m.role === "abtars_current_turn") return convertCurrentTurnToLlm(m);
        return m;
      });
    };

    const transformContext = async (messages: readonly AgentMessage[], signal?: AbortSignal): Promise<readonly AgentMessage[]> => {
      if (!this.opts.contextProjection) return messages;

      if (this.opts.safety && signal) {
        const turnDecision = this.opts.safety.beginProviderTurn(this.executionId);
        if (turnDecision.decision === "stop") {
          logDebug(TAG, `Provider turn stopped: ${turnDecision.reason}`);
        } else if (turnDecision.decision === "pause") {
          logDebug(TAG, "Provider turn paused");
        }
      }

      const cleanMessages = this.opts.safety
        ? this.opts.safety.scrubClassifiedLiterals(messages as unknown as Array<{ role: string; content: string }>) as unknown as AgentMessage[]
        : [...messages];

      const result = await this.opts.contextProjection.transform(cleanMessages, this.opts.transformOptions ?? { hostGeneration: 0 });
      if (this.outputObserver && result.contextDegraded) {
        this.outputObserver.end?.("error");
      }
      return result.messages;
    };

    const shouldStopAfterTurn = (_ctx: { roundsUsed: number; maxRounds: number }): boolean => {
      if (!this.opts.safety) return false;
      if (this.opts.safety.paused || this.opts.safety.stopped) return true;
      if (this.opts.safety.promptRoundsUsed >= 25) return true;
      return false;
    };

    const agentOptions: PiAgentOptions = {
      initialState: {
        systemPrompt,
        model: this.opts.initialState.model,
        messages: this.opts.initialState.messages,
        tools: this.opts.initialState.tools,
      },
      streamFn: this.opts.streamFn,
      steeringMode: PI_AGENT_CORE_CONFIG.steeringMode,
      followUpMode: PI_AGENT_CORE_CONFIG.followUpMode,
      toolExecution: PI_AGENT_CORE_CONFIG.toolExecution,
      loopConfig: { shouldStopAfterTurn },
      convertToLlm,
      transformContext,
      beforeToolCall: (_toolCallId: string, _toolName: string, _args: Record<string, unknown>): import("./pi-core-types.js").BeforeToolCallResult | undefined => {
        return undefined;
      },
      afterToolCall: (result: unknown): unknown => result,
      prepareNextTurnWithContext: (_ctx: unknown): unknown => {
        if (!this.opts.safety) return _ctx;
        const update = this.opts.safety.prepareNextTurn({
          candidateKey: this.executionId,
          roundsUsed: this.opts.safety.promptRoundsUsed,
          maxRounds: 25,
          incident: this.opts.safety.incident,
        });
        return update ?? _ctx;
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

    try {
      await this.agent.prompt(this.opts.initialState.messages);
    } catch (err) {
      if (this.state !== "running") {
        logDebug(TAG, `Prompt interrupted during startup (state=${this.state}): ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      logWarn(TAG, `Initial prompt failed: ${err instanceof Error ? err.message : String(err)}`);
      this.beginSettle("prompt_failure");
    }
  }

  // Cross-instance executionId deduplication is a #1446/#1447 production concern.

  private ensureSession(): ManagedSession | null {
    const s = this.opts.session;
    if (!s) return null;
    return s as unknown as ManagedSession;
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
      this.agent?.steer(msg);
    } catch (err) {
      logWarn(TAG, `steer() threw before queue insertion: ${err instanceof Error ? err.message : String(err)}`);
      this.outstandingLeases.delete(lease.leaseId);
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
      this.agent?.followUp(msg);
    } catch (err) {
      logWarn(TAG, `followUp() threw before queue insertion: ${err instanceof Error ? err.message : String(err)}`);
      this.outstandingLeases.delete(lease.leaseId);
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

    this.telemetry?.close();

    this.idlePromise = this.waitForIdleCleanup();

    this.settlementResolve?.();
    this.settlementPromise = null;

    if (this.outputObserver) {
      if (reason === "cancelled") {
        this.outputObserver.end?.("cancelled");
      } else if (reason && reason !== "agent_end") {
        this.outputObserver.end?.("error");
      } else {
        this.outputObserver.end?.("complete");
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
    if (this.settled && event.type !== "agent_end") return;

    if (event.type === "message_end") {
      this.handleMessageEnd(event.message);
    } else if (event.type === "agent_end") {
      this.handleAgentEnd(event);
    }

    // Map real Pi events to output observers
    if (event.type === "message_update") {
      const streamEv = event.assistantMessageEvent as { type?: string; delta?: string } | null;
      if (streamEv?.type === "text_delta" && streamEv.delta) {
        this.outputObserver?.onDelta?.({ kind: "text", text: streamEv.delta });
      }
      if (streamEv?.type === "thinking_delta" && streamEv.delta) {
        this.outputObserver?.onDelta?.({ kind: "thinking", text: streamEv.delta });
      }
    } else if (event.type === "tool_execution_start") {
      this.outputObserver?.onToolStart?.({ name: event.toolName });
    }

    try {
      await this.opts.onEvent?.(event);
    } catch (err) {
      logWarn(TAG, `Output observer threw (isolated): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private handleMessageEnd(message: AssistantMessage): void {
    if (!message.content) return;
    const firstLease = this.outstandingLeases.values().next().value;
    if (!firstLease) return;
    const session = this.ensureSession();
    if (session) {
      const fakeLease: InstructionLease = {
        leaseId: firstLease.leaseId,
        sessionId: this.sessionId,
        executionId: this.executionId,
        kind: firstLease.kind,
        instructions: firstLease.instructions as InstructionLease["instructions"],
      };
      markConsumed(fakeLease, session);
    }
    this.outstandingLeases.delete(firstLease.leaseId);
  }

  private handleAgentEnd(event: { messages?: readonly AgentMessage[] } | { reason?: string }): void {
    const reason = "reason" in event ? (event as { reason: string }).reason : "agent_end";
    logInfo(TAG, `Agent ended: ${reason}`);
    this.beginSettle(`agent_end: ${reason}`);
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
    return this.state === "running" && (this.agent?.isRunning ?? false);
  }

  get isSettled(): boolean {
    return this.settled;
  }
}
