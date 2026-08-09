import { logInfo, logWarn, logDebug } from "../logger.js";
import type { PiAgent, PiAgentOptions, AgentEvent, StreamFn, AgentMessage, LoadedPiAgentCore, ModelApi, BeforeToolCallContext, AgentLoopTurnUpdate } from "./pi-core-types.js";
import { convertMessagesToLlm, createInstructionMessage, PI_AGENT_CORE_CONFIG } from "./pi-core-types.js";
import type { InstructionLease, QueuedSessionInstruction } from "../spin-types.js";
import { markDelivered, markConsumed, failAfterDelivery } from "../session-instruction-queue.js";
import type { InstructionQueueHolder } from "../session-instruction-queue.js";
import { DurableContextUnavailableError } from "./pi-core-context.js";
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

/**
 * #1531: Outstanding lease with a deferred per-lease completion. `resolve`
 * fires only on the matching instruction `message_end`; `reject` fires exactly
 * once on host settlement, cancellation, or post-delivery handoff failure.
 */
interface OutstandingLease {
  lease: InstructionLease;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class PiCoreExecutionHost {
  readonly executionId: string;
  readonly sessionId: string;
  state: PiCoreHostState = "created";
  private agent: PiAgent | null = null;
  private unsub: (() => void) | null = null;
  private settled = false;
  private _cleanupPromise: Promise<"complete" | "timed_out"> = Promise.resolve("complete");
  private _terminalResolve: ((value: string) => void) | null = null;
  private _lastUsage: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null = null;
  readonly terminalPromise: Promise<string>;
  private outstandingLeases: Map<string, OutstandingLease> = new Map();
  private opts: PiCoreExecutionHostOptions;
  private outputObserver?: OutputObserver;
  private _generation: number;
  private static _hostCounter = 0;
  /**
   * #1531: Native-steering readiness. Resolved synchronously when the host
   * transitions to "running"; rejected when the host settles without ever
   * running. PiCoreTransport.steer() awaits it so an instruction accepted
   * while the host is still opening waits for handoff readiness instead of
   * being handed to a dead execution.
   */
  private _readyResolve: (() => void) | null = null;
  private _readyReject: ((error: Error) => void) | null = null;
  private readonly _readyPromise: Promise<void>;

  get generation(): number { return this._generation; }
  get ready(): Promise<void> { return this._readyPromise; }

  /** #1612: token usage captured from the terminal assistant message, if the provider reported any. */
  get lastUsage(): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null {
    return this._lastUsage;
  }

  constructor(opts: PiCoreExecutionHostOptions) {
    this.executionId = opts.executionId;
    this.sessionId = opts.sessionId;
    this.opts = opts;
    this.outputObserver = opts.outputObserver;
    this._generation = ++PiCoreExecutionHost._hostCounter;
    this.terminalPromise = new Promise((resolve) => { this._terminalResolve = resolve; });
    this._readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // Pre-attach a handler so a settlement-before-running rejection nobody
    // awaited is never an unhandled rejection.
    void this._readyPromise.catch(() => {});
    logDebug(TAG, `Host created for execution ${this.executionId} (session ${this.sessionId}) gen=${this._generation}`);
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
      this.beginSettle("agent_construct_failure");
      throw err;
    }

    // subscribe returns the promise so Pi awaits it — matches real contract
    this.unsub = this.agent.subscribe((event: AgentEvent, signal?: AbortSignal) => {
      return this.handleEvent(event, signal);
    });

    this.state = "running";
    if (this._readyResolve) {
      this._readyResolve();
      this._readyResolve = null;
      this._readyReject = null;
    }

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
        // A durable projection failure is a pre-provider execution error. Keep
        // the typed failure visible to PiCoreTransport and the pipeline instead
        // of converting it into a settled empty response that looks like a
        // model-side failure.
        if (err instanceof DurableContextUnavailableError) {
          this.beginSettle("context_projection_failure");
          throw err;
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

  /**
   * #1531: Per-lease steering acknowledgement. Validates before delivery,
   * registers a deferred lease, marks the batch delivered immediately before
   * `agent.steer()`, and resolves only when the matching instruction
   * `message_end` arrives. Never silently returns: an invalid state, a
   * missing agent, a lease for another session, or an outstanding lease all
   * produce an explicit pre-handoff error.
   */
  async steer(content: string, lease: InstructionLease): Promise<void> {
    const agent = this.agent;
    if (this.state !== "running") {
      throw new Error(`Cannot steer in state ${this.state}`);
    }
    if (!agent) {
      throw new Error("Cannot steer before Agent construction");
    }
    if (lease.sessionId !== this.sessionId) {
      throw new Error(`Steering lease belongs to session ${lease.sessionId}, host is ${this.sessionId}`);
    }
    if (this.outstandingLeases.size > 0) {
      const pending = this.outstandingLeases.keys().next().value as string;
      throw new Error(`Cannot steer — outstanding lease ${pending} not yet consumed`);
    }
    const msg = createInstructionMessage(
      content,
      lease.leaseId,
      lease.instructions.map((i) => i.id),
      this.executionId,
      "steer",
    );
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const deferred = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    this.outstandingLeases.set(lease.leaseId, { lease, resolve, reject });
    const session = this.ensureSession();
    if (session) markDelivered(lease);
    try {
      agent.steer(msg);
    } catch (err) {
      logWarn(TAG, `steer() threw before queue insertion: ${err instanceof Error ? err.message : String(err)}`);
      this.outstandingLeases.delete(lease.leaseId);
      if (session) failAfterDelivery(lease, session, "steer_handoff_failed");
      const e = err instanceof Error ? err : new Error(String(err));
      reject(e);
      throw e;
    }
    await deferred;
  }

  /**
   * #1531: Same per-lease deferred acknowledgement as `steer`, for follow-ups.
   * No Spin or TUI follow-up producer exists; the method stays for the Pi
   * contract and uses the same explicit rejection rules.
   */
  async followUp(content: string, lease: InstructionLease): Promise<void> {
    const agent = this.agent;
    if (this.state !== "running") {
      throw new Error(`Cannot followUp in state ${this.state}`);
    }
    if (!agent) {
      throw new Error("Cannot followUp before Agent construction");
    }
    if (lease.sessionId !== this.sessionId) {
      throw new Error(`Follow-up lease belongs to session ${lease.sessionId}, host is ${this.sessionId}`);
    }
    if (this.outstandingLeases.size > 0) {
      const pending = this.outstandingLeases.keys().next().value as string;
      throw new Error(`Cannot followUp — outstanding lease ${pending} not yet consumed`);
    }
    const msg = createInstructionMessage(
      content,
      lease.leaseId,
      lease.instructions.map((i) => i.id),
      this.executionId,
      "followUp",
    );
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const deferred = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    this.outstandingLeases.set(lease.leaseId, { lease, resolve, reject });
    const session = this.ensureSession();
    if (session) markDelivered(lease);
    try {
      agent.followUp(msg);
    } catch (err) {
      logWarn(TAG, `followUp() threw before queue insertion: ${err instanceof Error ? err.message : String(err)}`);
      this.outstandingLeases.delete(lease.leaseId);
      if (session) failAfterDelivery(lease, session, "followup_handoff_failed");
      const e = err instanceof Error ? err : new Error(String(err));
      reject(e);
      throw e;
    }
    await deferred;
  }

  /** #1506: Signal cancellation without awaiting provider/agent cleanup.
   *  Claims logical terminal state immediately so waitForSettlement()
   *  resolves. Cleanup continues in background with 5-second bound. */
  cancel(): void {
    if (this.state === "settled") return;
    if (this.state === "created") {
      this.terminalResolve("cancelled");
      this.settle("cancelled");
      return;
    }
    this.state = "aborting";
    this.agent?.abort();
    logInfo(TAG, `Cancel signalled for execution ${this.executionId}`);
    this.terminalResolve("cancelled");
    this.beginSettle("cancelled");
  }

  /** Logical terminalization — one-shot latch that waitForSettlement() resolves. */
  private terminalResolve(reason: string): void {
    if (this.settled) return;
    this._terminalResolve?.(reason);
    this._terminalResolve = null;
  }

  private beginSettle(reason: string): void {
    if (this.state === "settling" || this.state === "settled") return;
    this.state = "settling";
    this.terminalResolve(reason);
    logDebug(TAG, `Settling host for execution ${this.executionId}: ${reason}`);
    this.settle(reason);
  }

  private settle(reason?: string): void {
    if (this.settled) return;
    this.settled = true;
    this.state = "settled";

    // #1531: a host that settles before ever running must reject the
    // native-steering readiness promise so waiting steer() calls fail
    // terminally instead of hanging.
    if (this._readyReject) {
      this._readyReject(new Error(`Host settled before running (${reason ?? "unknown"})`));
      this._readyResolve = null;
      this._readyReject = null;
    }

    this.unsub?.();
    this.unsub = null;

    this.agent?.clearAllQueues();

    const session = this.ensureSession();
    for (const [, outstanding] of this.outstandingLeases) {
      const lease = outstanding.lease;
      const fakeLease: InstructionLease = {
        leaseId: lease.leaseId,
        sessionId: this.sessionId,
        executionId: this.executionId,
        kind: lease.kind,
        instructions: lease.instructions as InstructionLease["instructions"],
      };
      if (session) failAfterDelivery(fakeLease, session, "host_settled");
      outstanding.reject(new Error(`Host settled before lease ${lease.leaseId} completed`));
    }
    this.outstandingLeases.clear();

    this._cleanupPromise = this.startBoundedCleanup();

    if (this.outputObserver) {
      if (reason === "cancelled") {
        this.notifyOutput(() => this.outputObserver?.end?.("cancelled"));
      } else if (reason && reason !== "agent_end") {
        this.notifyOutput(() => this.outputObserver?.end?.("error"));
      } else {
        this.notifyOutput(() => this.outputObserver?.end?.("complete"));
      }
    }

    logInfo(TAG, `Host settled for execution ${this.executionId} gen=${this._generation}`);
  }

  /** #1506: Bounded cleanup — 5-second timeout on Agent.waitForIdle().
   *  Returns "complete" or "timed_out". Does NOT delay terminal resolution. */
  private async startBoundedCleanup(): Promise<"complete" | "timed_out"> {
    if (!this.agent) return "complete";
    const timeoutMs = 5000;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.agent.waitForIdle().then(() => "complete" as const),
        new Promise<"timed_out">((resolve) => {
          timeoutHandle = setTimeout(() => resolve("timed_out"), timeoutMs);
        }),
      ]);
      if (result === "timed_out") {
        logWarn(TAG, `Cleanup timed out for execution ${this.executionId} gen=${this._generation} after ${timeoutMs}ms`);
      } else {
        logInfo(TAG, `Cleanup complete for execution ${this.executionId} gen=${this._generation}`);
      }
      return result;
    } catch (err) {
      logDebug(TAG, `Cleanup error for execution ${this.executionId}: ${err instanceof Error ? err.message : String(err)}`);
      return "complete";
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  /** #1506: Returns the bounded cleanup result. Callers that need shutdown
   *  evidence can await this; it does NOT block terminal resolution. */
  async waitForCleanup(): Promise<"complete" | "timed_out"> {
    return this._cleanupPromise;
  }

  private async handleEvent(event: AgentEvent, _signal?: AbortSignal): Promise<void> {
    if (this.settled) {
      if (event.type === "agent_end") this.handleAgentEnd(event);
      return;
    }

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
    if (!outstanding || instruction.executionId !== this.executionId || instruction.kind !== outstanding.lease.kind) return;
    const expectedIds = outstanding.lease.instructions.map((item) => item.id);
    if (expectedIds.length !== instruction.instructionIds.length || expectedIds.some((id) => !instruction.instructionIds.includes(id))) return;

    const session = this.ensureSession();
    if (session) markConsumed(outstanding.lease, session);
    this.outstandingLeases.delete(instruction.leaseId);
    outstanding.resolve();
  }

  private handleAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): void {
    if (this.settled) {
      logWarn(TAG, `Late agent_end rejected for execution ${this.executionId} gen=${this._generation} — already terminal`);
      return;
    }
    // #1612: capture the real token usage from the final assistant message so
    // the transport can surface it to runtime status / the TUI footer. The
    // provider's usage lives on the assistant message; zero-only usage means
    // the provider reported none and stays null (never fabricated).
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const msg = event.messages[i];
      if (msg?.role === "assistant" && msg.usage) {
        const u = msg.usage;
        if (u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0) {
          this._lastUsage = {
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
          };
          logDebug(TAG, `Captured usage for execution ${this.executionId}: in=${u.input} out=${u.output}`);
          break;
        }
      }
    }
    this.terminalResolve("agent_end");
    logInfo(TAG, `Agent ended for execution ${this.executionId} gen=${this._generation}`);
    this.beginSettle("agent_end");
  }

  private notifyOutput(action: () => void): void {
    try {
      action();
    } catch (err) {
      logWarn(TAG, `Output observer failed (isolated): ${err instanceof Error ? err.name : "unknown"}`);
    }
  }

  /** #1506: Await ONLY logical terminalization, not cleanup/waitForIdle.
   *  This resolves as soon as cancel, agent_end, or a terminal event claims
   *  the terminal latch — cleanup continues independently. */
  async waitForSettlement(): Promise<void> {
    await this.terminalPromise;
  }

  get isRunning(): boolean {
    return this.state === "running" && (this.agent?.state.isStreaming ?? false);
  }

  get isSettled(): boolean {
    return this.settled;
  }
}
