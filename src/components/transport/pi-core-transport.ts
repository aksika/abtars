import { logDebug, logInfo, logWarn } from "../logger.js";
import type { IKiroTransport, PromptRequestContext, ReasoningEffort, ReasoningEffortState, RuntimeUsageSnapshot, RuntimeStatusSnapshot } from "./kiro-transport.js";
import type { CandidateSpec, ModelCandidate } from "./model-candidates.js";
import { PiAgentSessionStore } from "./pi-agent-session-store.js";
import type { PiAgentSessionTurnResult } from "./pi-agent-session-store.js";
import { DurableContextUnavailableError } from "./pi-core-context.js";
import type { PiConversationRole } from "../pi-session/pi-conversation-identity.js";
import { createPiExecutionSafetyController } from "./pi-core-safety.js";
import type { PiCoreToolContext } from "./pi-core-tools.js";
import type { SandboxPolicy } from "../tool-sandbox.js";
import type { OutputObserver } from "../session-output-feed.js";
import { resolveCandidateModel } from "./pi-ai-adapter.js";
import { PiCoreToolExecutionError, buildTerminalDiagnostic, shouldThrowAfterToolFailure } from "./tool-failure-diagnostic.js";
import type { ToolFailureDiagnosticV1 } from "./tool-failure-diagnostic.js";
import { ProviderExecutionError } from "./provider-failure.js";
import { markDelivered, markConsumed, failAfterDelivery } from "../session-instruction-queue.js";
import type { InstructionLease } from "../spin-types.js";

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
  /** #1932: exactly one configured candidate serves every turn. No fallback
   *  chain, no rotation, no health-gated selection. */
  candidate: ModelCandidate;
  sandboxPolicy: SandboxPolicy;
  session?: { instructionQueue: Array<import("../spin-types.js").QueuedSessionInstruction>; id: string };
  /** #1552: late-bound memory-tool dependencies holder (runtime + quota). */
  memoryToolDeps?: import("../memory-store-quota.js").MemoryToolDependenciesHolder;
  /** #1932: state directory for the durable provider-availability memo.
   *  Absent → the shared abtars state dir. Tests inject an isolated dir. */
  memoStateDir?: string;
  maxPromptRounds?: number;
  /** #1748: cache-identity scope. Main (absent) derives from the Spin session
   *  key at first sendPrompt; subagents pass the agent role name (all workers
   *  of one role share a system prompt, so a role-stable identity lets
   *  repeated spawns reuse the provider's cached prefix). Never shared between
   *  Main and subagents. */
  cacheScope?: string;
  /** #1748: per-provider prompt-cache retention. Absent → "short" (pi's
   *  default, pinned explicitly so a pi uplift cannot silently change it);
   *  "long" is opt-in per provider — Anthropic bills 1h cache writes at 2x
   *  base input, so it is never a global default. */
  cacheRetention?: import("@earendil-works/pi-ai").CacheRetention;
  /** #1932: Pi conversation role for session partitioning. Main transport
   *  uses "main"; subagent transports pass their worker role (dreamy,
   *  browsing, coding, task). */
  piRole?: PiConversationRole;
  /** #1932: SDK conversation state directory (bindings). Absent → the
   *  shared abtars state dir. Tests inject an isolated dir. */
  sdkStateDir?: string;
  /** #1932: SDK session-file storage root. Absent → state/pi-sessions.
   *  Tests inject an isolated dir. */
  sdkSessionRoot?: string;
  /** #1932: post-compaction bundle refresh (wired by boot for Main;
   *  subagents re-read their spawn-time bundle). Never throws.
   *  Retired with the bridge-built conversation (#1940: Pi owns compaction
   *  and the system prompt survives it); kept for signature compatibility
   *  and ignored. */
  onCompactionRefresh?: (sessionKey: string) => void;
  /** #1940: injectable AgentSession factory loader (tests). Production uses
   *  installed-Pi discovery and fails closed when unavailable. */
  sessionFactoryLoader?: import("./pi-agent-session-store.js").PiAgentSessionFactoryLoader;
  /**
   * #1506/#1932: bound for awaiting real idleness on interrupt. Cancel
   * itself is signal-only and never waits for provider acquisition (which
   * is bounded by the attempt's own inactivity timeout); the interrupt
   * observes teardown up to this bound, then returns. Tests inject a
   * small bound.
   */
  interruptIdleTimeoutMs?: number;
}

let executionSeq = 0;

/**
 * #1531: Execution-local steering slot. Created synchronously at the start of
 * `sendPrompt()` before its first await so a steer arriving while the SDK
 * conversation is still opening captures the slot and waits for readiness
 * instead of hitting a dead-execution error. Only one slot may be active on
 * a transport; finalization clears it only if it still owns the same
 * generation.
 */
interface ActivePiExecution {
  generation: number;
  sessionKey: string;
  executionId: string;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: unknown): void;
  settled: boolean;
}

/** Outstanding steering/follow-up lease awaiting its instruction ack. */
interface OutstandingLease {
  lease: InstructionLease;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class PiCoreTransport implements IKiroTransport {
  readonly config: { candidate: ModelCandidate; systemPrompt: string; role: string };
  private sandboxPolicy: SandboxPolicy;
  private session?: PiCoreTransportOptions["session"];
  private maxPromptRounds?: number;
  private maxToolRoundsOverride: number | null = null;
  private timeoutOverrideMs: number | null = null;
  private activeSlot: ActivePiExecution | null = null;
  private outstandingLeases = new Map<string, OutstandingLease>();
  private _executionGeneration = 0;
  private _isReady = false;
  private _lastUsage: RuntimeUsageSnapshot | null = null;
  /** #1573: shared in-flight initialization probe; cleared after settlement. */
  private _initializing: Promise<void> | null = null;

  /** #1552: late-bound memory-tool dependencies; read per execution. */
  private _memoryToolDeps: import("../memory-store-quota.js").MemoryToolDependenciesHolder;
  private _toolCallsSucceeded = 0;
  private _lastResponse = "";
  private _intermediateText = "";
  /** Most recent tool failure diagnostic from the current sendPrompt call. */
  private _lastToolFailure: ToolFailureDiagnosticV1 | null = null;

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
  /** #1940: in-memory AgentSession store (lazy; one per transport). */
  private agentSessions: PiAgentSessionStore | null = null;
  /** #1940: injectable session factory loader (tests). */
  private sessionFactoryLoader?: import("./pi-agent-session-store.js").PiAgentSessionFactoryLoader;
  private interruptIdleTimeoutMs: number;

  constructor(opts: PiCoreTransportOptions) {
    this.config = { candidate: opts.candidate, systemPrompt: opts.systemPrompt, role: opts.role };
    this.sandboxPolicy = opts.sandboxPolicy;
    this.session = opts.session;
    this._memoryToolDeps = opts.memoryToolDeps ?? { current: null };
    this.maxPromptRounds = opts.maxPromptRounds;
    if (opts.cacheScope !== undefined || opts.memoStateDir !== undefined || opts.cacheRetention !== undefined
      || opts.piRole !== undefined || opts.onCompactionRefresh !== undefined
      || opts.sdkStateDir !== undefined || opts.sdkSessionRoot !== undefined) {
      // Legacy Pi-route options (availability memo, SDK bindings, compaction
      // refresh) are retired with the bridge-built conversation (#1940).
    }
    this.sessionFactoryLoader = opts.sessionFactoryLoader;
    this.interruptIdleTimeoutMs = opts.interruptIdleTimeoutMs ?? 5000;
    // #1619: baseline from the configured candidate's effort-style config; a
    // transport without one starts at Pi's truthful headless baseline.
    const primary = opts.candidate;
    this.requestedEffort = primary?.thinking?.style === "effort"
      ? primary.thinking.default
      : "off";
    // The configured default is subject to the same Pi capability clamp as a
    // live `/effort` change. Without this, status can claim xhigh before the
    // first turn even though the initial model will actually run at high.
    this.effectiveEffort = resolveCandidateModel(primary, this.requestedEffort, false).effective;
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
   * effective level, and returns both. Applied live to open sessions via
   * Pi's setThinkingLevel so the conversation is kept; the next turn
   * carries it.
   */
  setReasoningEffort(level: ReasoningEffort): ReasoningEffortState {
    this.requestedEffort = level;
    const primary = this.config.candidate;
    const resolved = resolveCandidateModel(primary, level, false);
    this.effectiveEffort = resolved.effective;
    if (this.agentSessions) {
      for (const key of this.agentSessions.sessionKeys()) {
        try {
          this.agentSessions.setThinkingLevel(key, resolved.effective);
        } catch { /* best effort; next ensureSession carries it */ }
      }
    }
    return { requested: level, effective: resolved.effective };
  }

  /** #1619: clear measured context usage (reset/compaction). */
  invalidateContextUsage(): void {
    this.currentContextTokens = null;
  }

  setSystemPrompt(prompt: string): void {
    this.config.systemPrompt = prompt;
  }

  /** #1940: Pi owns compaction, so there is no post-compaction bundle
   *  refresh. Kept because boot probes for it; always clears. */
  setCompactionRefresh(_fn: ((sessionKey: string) => void) | undefined): void {
  }

  /** #1940 marker for the Pi AgentSession route (spin-profiles SOUL skip). */
  readonly piAgentSessionRoute = true;

  /** Manual compaction through Pi; the system prompt survives. */
  async compactSession(sessionKey: string, customInstructions?: string): Promise<unknown> {
    const store = this.sessionStore();
    return store.compact(sessionKey, customInstructions);
  }

  /** #1940: lazy AgentSession store, one per transport. */
  private sessionStore(): PiAgentSessionStore {
    if (!this.agentSessions) {
      this.agentSessions = new PiAgentSessionStore({
        ...(this.sessionFactoryLoader !== undefined ? { loadFactory: this.sessionFactoryLoader } : {}),
      });
    }
    return this.agentSessions;
  }

  /** /model and /effort keep the conversation: resolve the model through
   *  Pi's runtime and switch the live session without disposing it. */
  async setModel(model: string, endpoint?: string, maxContext?: number): Promise<void> {
    const primary = this.config.candidate;
    primary.model = model;
    if (endpoint) primary.endpoint = endpoint;
    if (maxContext) primary.maxContext = maxContext;
    this.effectiveEffort = resolveCandidateModel(primary, this.requestedEffort, false).effective;
    if (this.agentSessions) {
      const switched = this.agentSessions.modelForSwitch(primary);
      for (const key of this.agentSessions.sessionKeys()) {
        try {
          await this.agentSessions.setModel(key, switched);
        } catch { /* best effort; next turn resolves again */ }
      }
    }
  }

  setTimeoutOverride(ms: number | null): void { this.timeoutOverrideMs = ms; }

  setMaxToolRoundsOverride(rounds: number | null): void { this.maxToolRoundsOverride = rounds; }

  /**
   * #1531: Per-lease steering acknowledgement. Captures the current execution
   * slot, waits for conversation readiness, rechecks that the same execution
   * is still current, then hands the instruction message to the live SDK
   * agent. Never waits for the execution-wide settlement latch and never
   * returns response text — the initial send promise owns the final response.
   */
  async steer(content: string, lease: import("../spin-types.js").InstructionLease): Promise<void> {
    await this.handoffInstruction("steer", content, lease);
  }

  async followUp(content: string, lease: import("../spin-types.js").InstructionLease): Promise<void> {
    await this.handoffInstruction("followUp", content, lease);
  }

  private async handoffInstruction(
    kind: "steer" | "followUp",
    content: string,
    lease: InstructionLease,
  ): Promise<void> {
    const slot = this.activeSlot;
    if (!slot) throw new Error(`No active Pi execution to ${kind === "steer" ? "steer" : "follow-up"}`);
    try {
      await slot.ready;
    } catch (err) {
      throw new Error(`Pi execution failed before ${kind} readiness: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.activeSlot !== slot || slot.settled) {
      throw new Error(`Pi execution is no longer current — ${kind} rejected`);
    }
    if (lease.sessionId !== slot.sessionKey) {
      throw new Error(`Steering lease belongs to session ${lease.sessionId}, execution is ${slot.sessionKey}`);
    }
    if (this.outstandingLeases.size > 0) {
      const pending = this.outstandingLeases.keys().next().value as string;
      throw new Error(`Cannot ${kind} — outstanding lease ${pending} not yet consumed`);
    }
    const store = this.agentSessions;
    if (!store || !store.hasLive(slot.sessionKey)) {
      throw new Error(`Cannot ${kind} — AgentSession not opened`);
    }
    // #1940: steering goes through Pi's steer/followUp with the abtars
    // lease and generation fence only. Pi owns the queue; the handoff to
    // Pi is the backend acknowledgement that resolves the lease.
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const deferred = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    this.outstandingLeases.set(lease.leaseId, { lease, resolve, reject });
    if (this.session) markDelivered(lease);
    try {
      if (kind === "steer") store.steer(slot.sessionKey, content);
      else store.followUp(slot.sessionKey, content);
    } catch (err) {
      logWarn(TAG, `${kind}() threw before queue insertion: ${err instanceof Error ? err.message : String(err)}`);
      this.outstandingLeases.delete(lease.leaseId);
      if (this.session) failAfterDelivery(lease, this.session, `${kind}_handoff_failed`);
      const e = err instanceof Error ? err : new Error(String(err));
      reject(e);
      throw e;
    }
    if (this.session) markConsumed(lease, this.session);
    this.outstandingLeases.delete(lease.leaseId);
    resolve();
    await deferred;
  }

  // #1940: no instruction-message ack matching. Steering resolves when
  // the handoff to Pi's queue succeeds (see handoffInstruction); Pi never
  // persists abtars instruction roles.

  private rejectOutstandingLeases(reason: string): void {
    for (const [, outstanding] of this.outstandingLeases) {
      if (this.session) {
        const fakeLease: InstructionLease = {
          leaseId: outstanding.lease.leaseId,
          sessionId: outstanding.lease.sessionId,
          executionId: outstanding.lease.executionId,
          kind: outstanding.lease.kind,
          instructions: outstanding.lease.instructions,
        };
        failAfterDelivery(fakeLease, this.session, reason);
      }
      outstanding.reject(new Error(`Pi execution settled before lease ${outstanding.lease.leaseId} completed`));
    }
    this.outstandingLeases.clear();
  }

  /**
   * #1691: one active provider prompt per transport. A second sendPrompt()
   * is rejected before it can construct or assign a new slot, replace the
   * active conversation, or reset shared per-call state — the first call keeps
   * exclusive ownership of its conversation, slot, and finalizer until
   * settlement. The rejection propagates to Spin as an execution failure once
   * a durable run has bound, so the existing bounded failure release owns
   * the run.
   */
  private createActiveSlot(sessionKey: string, executionId: string): ActivePiExecution {
    if (this.activeSlot) {
      throw new Error("Pi execution already active — overlapping sendPrompt rejected");
    }
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Pre-attach a handler so a rejection nobody awaited (pre-conversation
    // send failure without any steer in flight) is never an unhandled
    // rejection. The rejection itself is observed by the caller awaiting the
    // slot.
    void ready.catch(() => { /* rejection is observed by the slot caller; this pre-attached handler only prevents unhandled-rejection surfacing */ });
    const slot: ActivePiExecution = {
      generation: ++this._executionGeneration,
      sessionKey,
      executionId,
      ready,
      resolveReady,
      rejectReady,
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
    await validatePiRuntimeContract([this.config.candidate]);
    this._isReady = true;
    this.onReady?.();
  }

  async sendPrompt(
    sessionKey: string,
    message: string,
    image?: { mime: string; base64: string },
    context?: PromptRequestContext,
  ): Promise<string> {
    // Use provided executionId or allocate a new one (before the slot: the
    // slot carries it for steering-lease identity).
    const executionId = context?.executionId ?? `${sessionKey}_${Date.now()}_${++executionSeq}`;
    // #1531: the execution slot exists synchronously before the first await so
    // a steer arriving while the SDK conversation is still opening can wait
    // on it. It is rejected on every pre-conversation failure, and cleared
    // only by its owning generation's finalizer.
    const slot = this.createActiveSlot(sessionKey, executionId);
    let deadlineExceeded = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      // Reset per-call state
      this._lastResponse = "";
      this._intermediateText = "";
      this._toolCallsSucceeded = 0;
      this._lastToolFailure = null;

      // #1529: fail closed when durable context is required but unavailable.
      // The intent is computed in prompt construction; an omitted intent means
      // the caller is outside the inbound durable pipeline (not-required). The
      // rejection happens before Pi loading, session opening, or any
      // provider request. Memory itself is decided once at abtars start
      // (#1940 R1): no per-turn admission or health probing here.
      const durableIntent = context?.durableContextIntent ?? { mode: "not_required" as const };
      const callerUserId = context?.userId;
      if (durableIntent.mode === "required_unavailable") {
        logDebug(TAG, "durable intent required_unavailable — rejecting before provider boundary");
        throw new DurableContextUnavailableError(durableIntent.reason);
      }
      if (durableIntent.mode === "durable" && !callerUserId) {
        logDebug(TAG, "durable intent without caller identity — rejecting before provider boundary");
        throw new DurableContextUnavailableError("identity_unavailable");
      }

      const safety = createPiExecutionSafetyController({
        // #1680: the intent-policy prompt bound overrides transport defaults
        // when the caller carries it (contract authoring keeps its narrow
        // 3-round ceiling; execution turns keep the wide bound).
        maxPromptRounds: context?.maxPromptRounds ?? this.maxToolRoundsOverride ?? this.maxPromptRounds,
      });

      // The role system prompt is captured once per session by the store
      // (#1940 R3); per-turn text carries hydration (first turn) and recall
      // (later turns) as built by the pipeline.
      const timeoutOverride = this.timeoutOverrideMs;
      const deadlineAt = context?.deadlineAt
        ?? (timeoutOverride && timeoutOverride > 0 ? Date.now() + timeoutOverride : undefined);

      // Build per-turn tool authority: the session's holder is set at the
      // start of every execution, never a first-turn capture.
      const toolContext: PiCoreToolContext = {
        executionId,
        userId: context?.userId ?? "unknown",
        signal: undefined,
        // #1786: per-execution override wins (peer deny-all); otherwise the
        // transport-constructed default. Both presentation (below) and
        // dispatch (executeToolCall via definitionToAgentTool) read this.
        sandboxPolicy: context?.sandboxPolicy ?? this.sandboxPolicy,
        safety,
        onToolFailure: (diag) => {
          this._lastToolFailure = diag;
        },
        executionScope: context?.executionScope,
        orcContext: context?.orcContext,
        // #1850: trusted worker origin for relay containment.
        workOrigin: context?.workOrigin,
        sessionType: context?.sessionType,
        memoryToolDeps: this._memoryToolDeps,
        // #1629: trusted per-execution tool authorization mode.
        authorizationMode: context?.authorizationMode,
        // #1680: turn-owned one-shot turn control for the bound Orc turn.
        orcTurnControl: context?.orcTurnControl,
      };
      // Ensure the live AgentSession: one Pi session per logical Spin
      // session, in memory. The role system prompt is captured once here;
      // restarts and /new//reset start the next conversation fresh.
      // Failures reject the slot so waiting steerers fail terminally
      // instead of hanging.
      const store = this.sessionStore();
      try {
        await store.ensureSession(sessionKey, {
          systemPrompt: this.config.systemPrompt,
          candidate: this.config.candidate,
          sandboxPolicy: context?.sandboxPolicy ?? this.sandboxPolicy,
          ...(context?.sessionType !== undefined ? { sessionType: context.sessionType } : {}),
          thinkingLevel: this.requestedEffort,
        });
      } catch (err) {
        slot.rejectReady(err);
        throw err;
      }
      slot.resolveReady();

      // Unattended attempt/deadline bounds still yield a visible terminal
      // failure: when the caller's deadline passes, abort the turn and mark
      // it so the tail below throws instead of returning partial text.
      // Pi owns retry and overflow recovery; abtars never masks errors.
      if (deadlineAt !== undefined) {
        const delay = Math.max(0, deadlineAt - Date.now());
        deadlineTimer = setTimeout(() => {
          deadlineExceeded = true;
          void store.abortTurn(sessionKey).catch(() => { /* teardown errors never fail the interrupt */ });
        }, delay);
        if (typeof deadlineTimer.unref === "function") deadlineTimer.unref();
      }
      const clearDeadline = (): void => {
        if (deadlineTimer !== null) {
          clearTimeout(deadlineTimer);
          deadlineTimer = null;
        }
      };

      // Collect response text and tool info from session events. The tap
      // mirrors every SDK session event for this turn; instruction acks
      // resolve steering leases, everything else feeds delivery callbacks.
      // Delivery is fire-and-forget with isolation: session dispatch does
      // not await subscribers, so an interim send failure never rejects the
      // model turn.
      let responseText = "";

      const outputObserver: OutputObserver | undefined = context?.outputObserver;

      const tap = (event: { type: string } & Record<string, unknown>): void => {
        const notifyOutput = (action: () => void): void => {
          try {
            action();
          } catch (err) {
            logWarn(TAG, `Output observer failed (isolated): ${err instanceof Error ? err.name : "unknown"}`);
          }
        };
        try {
          if (event.type === "tool_execution_start") {
            this.onToolCallStart?.(event["toolName"] as string);
            if (outputObserver) {
              const name = event["toolName"] as string;
              notifyOutput(() => outputObserver.onToolStart?.({ name }));
            }
          }
          if (event.type === "message_end") {
            const msg = event["message"] as unknown as { role?: string; content?: unknown };
            if (msg && msg.role === "assistant") {
              const text = extractAssistantText(msg.content);
              responseText = text;
              this._lastResponse = text;
              // #1619: complete user-visible assistant text before a tool
              // round is delivered before tool execution continues. Only tool-
              // carrying messages are semantic segments.
              if (hasToolCallContent(msg.content) && text) {
                try {
                  const r = this.onSegmentBreak?.(text);
                  if (r && typeof (r as Promise<void>).catch === "function") {
                    (r as Promise<void>).catch((err) => logWarn(TAG, `Segment break delivery failed (isolated): ${err instanceof Error ? err.message : String(err)}`));
                  }
                } catch (err) {
                  logWarn(TAG, `Segment break delivery failed (isolated): ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }
          }
          if (event.type === "message_update") {
            const streamEv = event["assistantMessageEvent"] as { type?: string; delta?: string } | null;
            if (streamEv?.type === "text_delta" && streamEv.delta) {
              this._intermediateText += streamEv.delta;
              this.onIntermediateResponse?.(streamEv.delta);
              this.onOutputDelta?.({ kind: "text", text: streamEv.delta });
              if (outputObserver) {
                const text = streamEv.delta;
                notifyOutput(() => outputObserver.onDelta?.({ kind: "text", text }));
              }
            }
            if (streamEv?.type === "thinking_delta" && streamEv.delta) {
              this.onOutputDelta?.({ kind: "thinking", text: streamEv.delta });
              if (outputObserver) {
                const text = streamEv.delta;
                notifyOutput(() => outputObserver.onDelta?.({ kind: "thinking", text }));
              }
            }
          }
          if (event.type === "tool_execution_end" && !event["isError"]) {
            this._toolCallsSucceeded++;
          }
        } catch (err) {
          logWarn(TAG, `Session event tap failed (isolated): ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      let turnResult: PiAgentSessionTurnResult;
      try {
        turnResult = await store.prompt(sessionKey, message, {
          executionId,
          toolContext,
          ...(image ? { images: [{ type: "image" as const, mimeType: image.mime, data: image.base64 }] } : {}),
          onEvent: tap,
        });
        clearDeadline();
        slot.settled = true;
        // The configured candidate serves every turn; a settled turn
        // commits it for live status ownership.
        this.committedCandidate = {
          model: this.config.candidate.model,
          provider: this.config.candidate.provider,
          endpoint: this.config.candidate.endpoint,
          maxContext: this.config.candidate.maxContext,
          apiFormat: this.config.candidate.apiFormat,
          thinking: this.config.candidate.thinking,
        };
        this.currentContextWindow = this.config.candidate.maxContext;
        if (outputObserver) {
          const reason = turnResult.aborted ? "cancelled" as const : "complete" as const;
          try {
            outputObserver.end?.(reason);
          } catch (err) {
            logWarn(TAG, `Output observer failed (isolated): ${err instanceof Error ? err.name : "unknown"}`);
          }
        }

        // #1680: map the typed terminal outcomes onto the turn-owned control
        // so Spin persists stable bounded failure codes. A cancelled turn
        // and a prompt-round-limit incident are the two transport-level
        // terminal classes; the durable run release reads the control.
        if (turnResult.aborted && context?.orcTurnControl) {
          context.orcTurnControl.complete({ kind: "cancelled", failureCode: "turn_cancelled" });
        }
        if (
          context?.orcTurnControl
          && safety.terminalSafetyFailure
          && safety.lastTerminalIncident?.type === "prompt_round_limit"
        ) {
          context.orcTurnControl.complete({ kind: "failed", failureCode: "prompt_round_limit" });
        }

        if (context?.executionTelemetry) {
          const snap = context.executionTelemetry.snapshot();
          if (snap) this._lastUsage = snap;
        }
        // #1612: prefer the turn's captured assistant-message usage (real
        // provider tokens) over the telemetry scope, which pi-core never
        // populates with token counts.
        if (turnResult.usage) {
          this._lastUsage = turnResult.usage;
        }
        // #1619: pair the current-context token measurement with the window of
        // the candidate that actually committed. Only valid usage counts.
        if (turnResult.contextTokens !== null && turnResult.contextTokens > 0) {
          this.currentContextTokens = turnResult.contextTokens;
          this.currentContextWindow = this.committedCandidate?.maxContext
            ?? this.config.candidate.maxContext;
          logDebug(TAG, `Context usage captured: ${turnResult.contextTokens} tokens / ${this.currentContextWindow ?? "?"} window`);
        }
        // #1932: the session collector counts successful tool executions;
        // keep the transport-level counter in sync for status consumers.
        this._toolCallsSucceeded = turnResult.toolCallsSucceeded;

        // #1940: an unattended deadline that fired aborts the turn and
        // surfaces a visible terminal failure (never silent, never masked).
        if (deadlineExceeded && turnResult.aborted) {
          throw new ProviderExecutionError({
            code: "all_candidates_failed",
            retryable: false,
            attemptedCandidates: 1,
            message: "Turn deadline exceeded — aborted before Pi settled",
          });
        }

        // #1595: the terminal cause leads; a prior tool failure is supporting
        // context only. Never present a stale tool failure as the primary
        // reason.
        if (safety.terminalSafetyFailure && safety.lastTerminalIncident) {
          const inc = safety.lastTerminalIncident;
          logInfo(TAG, `sendPrompt: terminal safety incident (${inc.type}) — leading with terminal cause, prior tool failure retained as context`);
          throw new PiCoreToolExecutionError(buildTerminalDiagnostic(executionId, inc, this._lastToolFailure ?? undefined));
        }

        if (responseText.trim() !== "") {
          logDebug(TAG, `sendPrompt: returning ${responseText.length}ch assistant text`);
          return responseText;
        }

        // #1767: R8's silent path is scoped to unattended-sleep execution
        // only. A plain nonzero_exit (or policy_rejected /
        // shell_syntax_error) returns "" solely for the sleep pump, which
        // treats an empty turn after a surfaced tool error as a completed
        // step (#1752 R8). Every other origin — scheduled unattended-task
        // runs, interactive chat, unverified provenance, direct transport
        // callers — fails closed with the thrown diagnostic (pre-R8
        // behavior): an Orc that stops after its artifact write failed,
        // without writing the artifact and without any error surfacing, is
        // a failure (Molty 2026-09-04: finance-daily settled success with
        // no artifact; daily-ai burned its idle budget in silence).
        const lastFailure: ToolFailureDiagnosticV1 | null = this._lastToolFailure;
        if (lastFailure) {
          const reason = (lastFailure as ToolFailureDiagnosticV1).reason;
          // #1767: throw unless the sleep origin owns the silent path (see
          // shouldThrowAfterToolFailure — R8 scoped to unattended-sleep).
          if (shouldThrowAfterToolFailure(reason, context?.authorizationMode)) {
            logInfo(TAG, `sendPrompt: empty response with tool failure (${reason}) — throwing diagnostic`);
            throw new PiCoreToolExecutionError(lastFailure);
          }
          logInfo(TAG, `sendPrompt: empty response with non-terminal tool failure (${reason}) — returning "" (sleep origin, recording preserved)`);
        }

        // #1297: a committed successful output and a terminal tool failure
        // already took precedence. Real provider errors reach Pi unmodified
        // so its retry and overflow recovery fire; only the unattended
        // deadline above and the generic empty-response behavior below
        // remain. No masked terminal failure → current generic
        // empty-response behavior.
        logDebug(TAG, `sendPrompt: empty response with no tool failure — returning ""`);
        return "";
      } finally {
        clearDeadline();
        // Outstanding leases never survive their turn: resolve-or-reject
        // exactly once, mirroring the old host settlement behavior.
        if (this.activeSlot === slot) this.rejectOutstandingLeases("turn_settled");
      }
    } catch (err) {
      slot.rejectReady(err);
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      const observer = context?.outputObserver;
      if (observer) {
        try {
          observer.end?.("error");
        } catch (observerErr) {
          logWarn(TAG, `Output observer failed (isolated): ${observerErr instanceof Error ? observerErr.name : "unknown"}`);
        }
      }
      throw err;
    } finally {
      this.clearActiveSlot(slot);
    }
  }

  /**
   * #1940: ending or replacing a session clears Pi's queues, aborts and
   * waits for idle, then disposes the session before its successor runs.
   * The next conversation starts fresh; continuity comes only from abmind
   * hydration. Requested effort survives on the same transport instance.
   */
  async resetSession(sessionKey: string): Promise<void> {
    await this.agentSessions?.disposeSession(sessionKey).catch(() => { /* teardown errors never fail the reset */ });
    // #1619: reset/compaction invalidates measured usage; requested effort
    // survives on the same transport instance.
    this.currentContextTokens = null;
    this.currentContextWindow = null;
    this.committedCandidate = null;
  }

  async sendInterrupt(_reason?: string): Promise<void> {
    const slot = this.activeSlot;
    const store = this.agentSessions;
    if (!slot || !store || !store.hasLive(slot.sessionKey)) return;
    // Signal-only abort (never waits for provider acquisition); then
    // observe teardown up to a bound so a wedged provider cannot stall
    // the interrupt. Cancel keeps the conversation so a steer/follow-up
    // can still land; dispose is reserved for reset/destroy.
    await store.abortTurn(slot.sessionKey).catch(() => { /* teardown errors never fail the interrupt */ });
    const bound = this.interruptIdleTimeoutMs;
    await Promise.race([
      store.waitForIdle(slot.sessionKey).catch(() => { /* teardown errors never fail the interrupt */ }),
      new Promise<void>((resolve) => setTimeout(resolve, bound)),
    ]);
  }

  destroy(): void {
    const slot = this.activeSlot;
    if (slot && this.agentSessions?.hasLive(slot.sessionKey)) {
      void this.agentSessions.abortTurn(slot.sessionKey).catch(() => { /* teardown never fails destroy */ });
    }
    if (this.agentSessions) {
      void this.agentSessions.disposeAll().catch(() => { /* teardown never fails destroy */ });
      this.agentSessions = null;
    }
    this.rejectOutstandingLeases("transport_destroyed");
    this._isReady = false;
    this.committedCandidate = null;
    this.currentContextTokens = null;
    this.currentContextWindow = null;
  }

  lastUsage(): RuntimeUsageSnapshot | null {
    return this._lastUsage;
  }

  getRuntimeStatus(): RuntimeStatusSnapshot {
    const live = this.committedCandidate ?? this.config.candidate;
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
