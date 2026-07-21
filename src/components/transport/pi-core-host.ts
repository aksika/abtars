import { logInfo, logWarn, logError, logDebug } from "../logger.js";
import type { PiAgent, PiAgentOptions, AgentEvent, AssistantMessage, StreamFn, AgentMessage, LoadedPiAgentCore } from "./pi-core-types.js";
import { convertInstructionToLlm, createInstructionMessage, PI_AGENT_CORE_CONFIG } from "./pi-core-types.js";
import type { ExecutionTelemetryScope } from "../execution-telemetry.js";
import type { InstructionLease, QueuedSessionInstruction } from "../spin-types.js";
import { markDelivered, markConsumed, failAfterDelivery } from "../session-instruction-queue.js";
import type { InstructionQueueHolder } from "../session-instruction-queue.js";

const TAG = "pi-core-host";

export type PiCoreHostState = "created" | "running" | "aborting" | "settling" | "settled";

export interface PiCoreExecutionHostOptions {
  executionId: string;
  sessionId: string;
  initialState: {
    systemPrompt: string;
    model: unknown;
    messages: AgentMessage[];
  };
  streamFn: StreamFn;
  session?: { instructionQueue: QueuedSessionInstruction[]; id: string };
  executionTelemetry?: ExecutionTelemetryScope;
  convertToLlm?: PiAgentOptions["convertToLlm"];
  transformContext?: PiAgentOptions["transformContext"];
  tools?: readonly unknown[];
  beforeToolCall?: PiAgentOptions["beforeToolCall"];
  afterToolCall?: PiAgentOptions["afterToolCall"];
  prepareNextTurnWithContext?: PiAgentOptions["prepareNextTurnWithContext"];
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

  constructor(opts: PiCoreExecutionHostOptions) {
    this.executionId = opts.executionId;
    this.sessionId = opts.sessionId;
    this.opts = opts;
    this.telemetry = opts.executionTelemetry;
    logDebug(TAG, `Host created for execution ${this.executionId} (session ${this.sessionId})`);
  }

  async start(loaded: LoadedPiAgentCore): Promise<void> {
    if (this.state !== "created") {
      throw new Error(`Cannot start host in state ${this.state}`);
    }
    if (this.executionId !== loaded.installation.version) {
      logDebug(TAG, `Host executionId=${this.executionId} piVersion=${loaded.installation.version}`);
    }

    const agentOptions: PiAgentOptions = {
      systemPrompt: this.opts.initialState.systemPrompt || undefined,
      model: this.opts.initialState.model,
      streamFn: this.opts.streamFn,
      tools: this.opts.tools,
      steeringMode: PI_AGENT_CORE_CONFIG.steeringMode,
      followUpMode: PI_AGENT_CORE_CONFIG.followUpMode,
      toolExecution: PI_AGENT_CORE_CONFIG.toolExecution,
      convertToLlm: this.opts.convertToLlm ?? convertInstructionToLlm,
      transformContext: this.opts.transformContext,
      beforeToolCall: this.opts.beforeToolCall,
      afterToolCall: this.opts.afterToolCall,
      prepareNextTurnWithContext: this.opts.prepareNextTurnWithContext,
    };

    try {
      this.agent = new loaded.module.Agent(agentOptions);
    } catch (err) {
      this.settle();
      throw err;
    }

    this.unsub = this.agent.subscribe((event: AgentEvent) => {
      this.handleEvent(event).catch((err) => {
        logError(TAG, `Event handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
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

  private ensureSession(): InstructionQueueHolder | null {
    return this.opts.session ?? null;
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
    this.settle();
  }

  private settle(): void {
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

  private async handleEvent(event: AgentEvent): Promise<void> {
    if (this.settled && event.type !== "agent_end") {
      return;
    }

    if (event.type === "message_end") {
      this.handleMessageEnd(event.message);
    } else if (event.type === "agent_end") {
      this.handleAgentEnd(event);
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

  private handleAgentEnd(event: { reason: string }): void {
    logInfo(TAG, `Agent ended: ${event.reason}`);
    this.beginSettle(`agent_end: ${event.reason}`);
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
