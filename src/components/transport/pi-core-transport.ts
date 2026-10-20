import { join } from "node:path";
import { logDebug, logInfo, logWarn } from "../logger.js";
import { abtarsHome } from "../../paths.js";
import type { IKiroTransport, PromptRequestContext, ReasoningEffort, ReasoningEffortState, RuntimeUsageSnapshot, RuntimeStatusSnapshot } from "./kiro-transport.js";
import type { CandidateSpec, ModelCandidate } from "./model-candidates.js";
import { PiSdkConversationStore } from "./pi-sdk-conversation.js";
import type { SdkAgentAssembly, SdkConversationKey, SdkTurnResult } from "./pi-sdk-conversation.js";
import { DurableContextUnavailableError } from "./pi-core-context.js";
import type { PiDurableContextProvider } from "./pi-core-context.js";
import { createPiStreamFn } from "./pi-stream-fn.js";
import { createPiAgentTools } from "./pi-core-tools.js";
import type { PiCoreToolContext } from "./pi-core-tools.js";
import { createPiExecutionSafetyController } from "./pi-core-safety.js";
import type { PiExecutionSafetyController } from "./pi-core-safety.js";
import type { Model as PiAiModel, Api as PiAiApi } from "@earendil-works/pi-ai";
import type { SandboxPolicy } from "../tool-sandbox.js";
import { createInstructionMessage } from "./pi-core-types.js";
import type { AgentMessage } from "./pi-core-types.js";
import type { OutputObserver } from "../session-output-feed.js";
import type { DurableContextProviderHolder } from "./pi-core-context.js";
import { resolveCandidateModel, deriveCacheIdentity } from "./pi-ai-adapter.js";
import { candidateKey } from "./model-candidates.js";
import { PiCoreToolExecutionError, buildTerminalDiagnostic, shouldThrowAfterToolFailure } from "./tool-failure-diagnostic.js";
import type { ToolFailureDiagnosticV1 } from "./tool-failure-diagnostic.js";
import { ProviderExecutionError } from "./provider-failure.js";
import type { ProviderTerminalFailure } from "./provider-failure.js";
import { admitPiSelection } from "../pi-session/pi-availability-admission.js";
import { loadAvailabilityMemo } from "../pi-session/provider-availability-memo.js";
import { PiSoulGate } from "../pi-session/pi-soul-gate.js";
import { sharedArchiveOutbox } from "../pi-session/pi-archive-outbox.js";
import { buildSdkTransform, buildRequestSystemText } from "./pi-sdk-transform.js";
import type { PiConversationRole } from "../pi-session/pi-conversation-identity.js";
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
  /** #1527: late-bound durable context provider holder (parallel boot composition). */
  contextProvider?: DurableContextProviderHolder;
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
  /** #1932: injectable SDK surface loader (tests). Production uses
   *  installed-Pi discovery and fails closed when unavailable. */
  sdkLoadSurface?: import("./pi-sdk-conversation.js").PiSdkConversationSurfaceLoader;
  /** #1932: post-compaction bundle refresh (wired by boot for Main;
   *  subagents re-read their spawn-time bundle). Never throws. */
  onCompactionRefresh?: (sessionKey: string) => void;
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

  /** #1527: late-bound durable context provider; populated once memory is ready. */
  private _contextProvider: DurableContextProviderHolder;
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
  /** #1748: opaque cache identity, derived once per transport from the first
   *  session key (main) or the agent role scope (subagent). Survives candidate
   *  rotation; cleared on resetSession so a new session derives a fresh
   *  identity. Null means "not yet derived". */
  private cacheIdentity: string | null = null;
  /** #1748: explicit retention sent on every call; "short" unless a provider
   *  opts into "long". */
  private cacheRetention: import("@earendil-works/pi-ai").CacheRetention;
  /** #1748: subagent cache-identity scope (agent role name). */
  private cacheScope?: string;
  /** #1932: memo state dir for availability admission. */
  private memoStateDir: string;
  /** #1932: Pi conversation role for session partitioning. */
  private piRole: PiConversationRole;
  /** #1932: SDK conversation store (lazy; one per transport). */
  private sdkStore: PiSdkConversationStore | null = null;
  /** #1932: per-conversation SOUL/hydration gates. */
  private soulGates = new Map<string, PiSoulGate>();
  /** #1932: per-conversation turn generations for gate fencing. */
  private turnGenerations = new Map<string, number>();
  /** #1932: per-conversation agent-assembly fingerprints. A change rebuilds
   *  the in-memory wrapper around the SAME conversation ID (history kept). */
  private assemblyFingerprints = new Map<string, string>();
  /** #1932: per-turn mutable state read by the SDK transform closure. */
  private turnState: {
    safety: PiExecutionSafetyController;
    source: { mode: "durable"; sessionKey: string; beforeMessageId: number; maxContext: number; userId: string } | { mode: "ephemeral"; sessionKey: string };
    volatileBlocks: Array<{ kind: string; content: string }>;
    executionId: string;
    contextProvider?: PiDurableContextProvider;
    candidateKey: string;
    /**
     * First transform denial of the turn. Pi settles a denied request as
     * an error turn instead of propagating the throw, so the transform
     * records it here and the tail below surfaces it (typed) instead of
     * reporting a successful empty answer.
     */
    denied: unknown;
  } | null = null;
  /** #1932: post-compaction bundle refresh (boot-wired for Main). */
  private onCompactionRefresh?: (sessionKey: string) => void;
  /** #1932: injectable SDK surface loader (tests). */
  private sdkLoadSurface?: import("./pi-sdk-conversation.js").PiSdkConversationSurfaceLoader;
  /** #1932: SDK state/session roots (bindings + Pi files). */
  private sdkStateDir: string;
  private sdkSessionRoot: string;
  private interruptIdleTimeoutMs: number;

  constructor(opts: PiCoreTransportOptions) {
    this.config = { candidate: opts.candidate, systemPrompt: opts.systemPrompt, role: opts.role };
    this.sandboxPolicy = opts.sandboxPolicy;
    this.session = opts.session;
    this._contextProvider = opts.contextProvider ?? { current: null };
    this._memoryToolDeps = opts.memoryToolDeps ?? { current: null };
    this.cacheScope = opts.cacheScope;
    // #1932: shared availability memo location; tests inject isolation.
    this.memoStateDir = opts.memoStateDir ?? join(abtarsHome(), "state");
    // #1748: "short" is pinned explicitly — pi's default today, made abtars's
    // own so a future pi uplift that changes the default cannot silently
    // change the shipped behavior. "long" is per-provider opt-in only.
    this.cacheRetention = opts.cacheRetention ?? "short";
    this.maxPromptRounds = opts.maxPromptRounds;
    this.piRole = opts.piRole ?? "main";
    this.onCompactionRefresh = opts.onCompactionRefresh;
    this.sdkLoadSurface = opts.sdkLoadSurface;
    this.sdkStateDir = opts.sdkStateDir ?? join(abtarsHome(), "state");
    this.sdkSessionRoot = opts.sdkSessionRoot ?? join(abtarsHome(), "state", "pi-sessions");
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
   * effective level, and returns both. Never reaches into an active host, so
   * an in-flight provider request remains unchanged; the next turn carries it.
   */
  setReasoningEffort(level: ReasoningEffort): ReasoningEffortState {
    this.requestedEffort = level;
    const primary = this.config.candidate;
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

  /** #1932: post-Pi-compaction bundle refresh (boot-wired for Main). */
  setCompactionRefresh(fn: ((sessionKey: string) => void) | undefined): void {
    this.onCompactionRefresh = fn;
  }

  async setModel(model: string, endpoint?: string, maxContext?: number): Promise<void> {
    const primary = this.config.candidate;
    primary.model = model;
    if (endpoint) primary.endpoint = endpoint;
    if (maxContext) primary.maxContext = maxContext;
    this.effectiveEffort = resolveCandidateModel(primary, this.requestedEffort, false).effective;
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
    const store = this.sdkStore;
    if (!store) throw new Error(`Cannot ${kind} — SDK conversation not opened`);
    const msg = createInstructionMessage(
      content,
      lease.leaseId,
      lease.instructions.map((i) => i.id),
      slot.executionId,
      kind,
    );
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const deferred = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    this.outstandingLeases.set(lease.leaseId, { lease, resolve, reject });
    if (this.session) markDelivered(lease);
    try {
      if (kind === "steer") store.steer(slot.sessionKey, msg);
      else store.followUp(slot.sessionKey, msg);
    } catch (err) {
      logWarn(TAG, `${kind}() threw before queue insertion: ${err instanceof Error ? err.message : String(err)}`);
      this.outstandingLeases.delete(lease.leaseId);
      if (this.session) failAfterDelivery(lease, this.session, `${kind}_handoff_failed`);
      const e = err instanceof Error ? err : new Error(String(err));
      reject(e);
      throw e;
    }
    await deferred;
  }

  /**
   * Match an instruction ack arriving as a session event. Instruction
   * messages carry the abtars_instruction role, which Pi never persists —
   * the ack resolves the lease here and marks queue consumption.
   */
  private matchInstructionAck(message: unknown): void {
    const instruction = message as {
      role?: string; leaseId?: string; executionId?: string; kind?: string; instructionIds?: string[];
    };
    if (!instruction || instruction.role !== "abtars_instruction") return;
    const outstanding = this.outstandingLeases.get(instruction.leaseId ?? "");
    if (!outstanding) return;
    const slot = this.activeSlot;
    if (!slot || instruction.executionId !== slot.executionId) return;
    if (instruction.kind !== outstanding.lease.kind) return;
    const expectedIds = outstanding.lease.instructions.map((item) => item.id);
    const gotIds = instruction.instructionIds ?? [];
    if (expectedIds.length !== gotIds.length || expectedIds.some((id) => !gotIds.includes(id))) return;
    if (this.session) markConsumed(outstanding.lease, this.session);
    this.outstandingLeases.delete(instruction.leaseId ?? "");
    outstanding.resolve();
  }

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
    try {
      // Reset per-call state
      this._lastResponse = "";
      this._intermediateText = "";
      this._toolCallsSucceeded = 0;
      this._lastToolFailure = null;
      // #1297: terminal-failure state is allocated per execution — a previous
      // request's failure can never contaminate a later request.
      const executionState: { terminalFailure: ProviderTerminalFailure | null } = { terminalFailure: null };

      // #1529: fail closed when durable context is required but unavailable.
      // The intent is computed in prompt construction; an omitted intent means
      // the caller is outside the inbound durable pipeline (not-required). The
      // rejection happens before model selection, stream construction, Pi
      // loading, conversation opening, or any provider request.
      const durableIntent = context?.durableContextIntent ?? { mode: "not_required" as const };
      const callerUserId = context?.userId;
      if (durableIntent.mode === "required_unavailable") {
        logDebug(TAG, "durable intent required_unavailable — rejecting before provider boundary");
        // #1932: propagate the intent's reason instead of masking every
        // pre-provider failure as cursor_unavailable.
        throw new DurableContextUnavailableError(durableIntent.reason);
      }
      if (durableIntent.mode === "durable" && !callerUserId) {
        logDebug(TAG, "durable intent without caller identity — rejecting before provider boundary");
        throw new DurableContextUnavailableError("identity_unavailable");
      }

      // #1932: suppress dispatch while the configured selection cools down.
      // Best-effort read — an unreadable memo admits, and the provider still
      // enforces its own errors. A block throws the typed unavailable
      // failure before stream construction, Pi loading, conversation opening,
      // or any provider request, so scheduled work settles visibly instead
      // of retrying a known-dead provider. No credential values or provider
      // names in the message.
      {
        const candidate = this.config.candidate;
        const memoVerdict = admitPiSelection(
          [{
            authNamespace: `${candidate.authSource ?? "abtars"}:${candidate.provider}`,
            provider: candidate.provider,
            endpoint: candidate.endpoint,
            modelScope: candidate.model,
          }],
          loadAvailabilityMemo(this.memoStateDir).entries,
          Date.now(),
        );
        if (!memoVerdict.admit) {
          throw new ProviderExecutionError({
            code: "provider_unavailable",
            retryable: false,
            attemptedCandidates: 1,
            message: `The configured provider is cooling down; retry after ${new Date(memoVerdict.retryAt).toISOString()}`,
            retryAt: memoVerdict.retryAt,
          });
        }
      }

      // #1748: cache identity — derived ONCE per transport from the first
      // session key (main) or the agent role scope (subagent), never per
      // turn or per execution. resetSession clears it so a new session
      // derives a fresh identity.
      if (this.cacheIdentity === null) {
        this.cacheIdentity = deriveCacheIdentity(this.cacheScope ?? sessionKey);
      }

      // #1932: resolve the durable SDK conversation key. The binding
      // (sessionKey → conversation ID) survives restarts; partitioning is
      // by trusted principal, role, and workspace. Platform is parsed
      // opportunistically from the session-key prefix; "unknown" is honest
      // when the key carries none.
      const conversationKey = this.conversationKeyFor(sessionKey, context);

      const safety = createPiExecutionSafetyController({
        // #1680: the intent-policy prompt bound overrides transport defaults
        // when the caller carries it (contract authoring keeps its narrow
        // 3-round ceiling; execution turns keep the wide bound).
        maxPromptRounds: context?.maxPromptRounds ?? this.maxToolRoundsOverride ?? this.maxPromptRounds,
      });

      // Context seed: durable vs ephemeral. A durable seed requires the
      // just-persisted cursor and a non-empty caller identity, both enforced by
      // the #1529 preflight above.
      const source = durableIntent.mode === "durable"
        ? { mode: "durable" as const, sessionKey, beforeMessageId: durableIntent.beforeMessageId, maxContext: this.config.candidate.maxContext, userId: callerUserId! }
        : { mode: "ephemeral" as const, sessionKey };

      const volatileBlocks: Array<{ kind: string; content: string }> = [];
      if (context?.directContextTurn?.volatileBlocks) {
        volatileBlocks.push(...context.directContextTurn.volatileBlocks);
      }

      // Build the Pi model from the single configured candidate.
      const piModel = this.resolveModel(this.config.candidate, Boolean(image)).model;

      const timeoutOverride = this.timeoutOverrideMs;
      const deadlineAt = context?.deadlineAt
        ?? (timeoutOverride && timeoutOverride > 0 ? Date.now() + timeoutOverride : undefined);

      // Build StreamFn — no emergency L0, no legacy conversion
      const streamFn = createPiStreamFn({
        candidate: this.config.candidate,
        executionId,
        telemetry: context?.executionTelemetry,
        deadlineAt,
        providerInactivityTimeoutMs: context?.providerInactivityTimeoutMs ?? 180_000,
        reasoningEffort: this.requestedEffort,
        // #1932: durable availability observations land in the shared
        // state dir. Write-only and best-effort: memo failures never break
        // a turn.
        memoStateDir: join(abtarsHome(), "state"),
        // #1748: the session-stable cache identity and the pinned retention
        // reach the provider attempt through the stream options.
        cacheIdentity: this.cacheIdentity,
        cacheRetention: this.cacheRetention,
        onCandidateCommitted: (candidate) => {
          const successful: CandidateSpec = {
            model: candidate.model,
            provider: candidate.provider,
            endpoint: candidate.endpoint,
            maxContext: candidate.maxContext,
            apiFormat: candidate.apiFormat,
            thinking: candidate.thinking,
          };
          // #1619: the candidate that actually commits owns live provider/model/
          // window/effective-effort state.
          this.committedCandidate = successful;
          const resolved = this.resolveModel(candidate, Boolean(image));
          this.effectiveEffort = resolved.effective;
          this.currentContextWindow = candidate.maxContext;
          logDebug(TAG, `Candidate committed: ${candidate.model} (effort: ${this.requestedEffort} → ${resolved.effective})`);
        },
        onTerminalFailure: (failure) => {
          executionState.terminalFailure = failure;
          logDebug(TAG, `sendPrompt: terminal provider failure ${failure.code}`);
        },
      });

      // Build registry-derived tools
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
      const tools = createPiAgentTools(toolContext);

      // #1932: per-turn SDK transform state. The agent persists per
      // conversation but admission/hydration/SOUL inputs are per turn; the
      // transform closure below reads this holder, refreshed here before
      // every prompt.
      this.turnState = {
        safety,
        source,
        volatileBlocks,
        executionId,
        contextProvider: context?.contextProvider ?? this._contextProvider.current ?? undefined,
        candidateKey: candidateKey(this.config.candidate.model, this.config.candidate.endpoint),
        denied: null,
      };

      // #1932: per-conversation hydration gate + turn generation. The gate
      // begins pending on first open; compaction re-pends it; cancel closes
      // it so a late transform cannot admit another request.
      let gate = this.soulGates.get(sessionKey);
      if (!gate) {
        gate = new PiSoulGate();
        gate.beginSession();
        this.soulGates.set(sessionKey, gate);
      }
      const generation = (this.turnGenerations.get(sessionKey) ?? 0) + 1;
      this.turnGenerations.set(sessionKey, generation);

      // #1932: rebuild the in-memory wrapper only when the agent assembly
      // changed (tools, model, effort, authorization). The conversation ID
      // and Pi history are untouched — only the wrapper is re-created.
      // Failures reject the slot so waiting steerers fail terminally
      // instead of hanging.
      const fingerprint = this.assemblyFingerprint(toolContext, tools, piModel);
      const store = this.sdkStoreFor();
      try {
        if (fingerprint !== this.assemblyFingerprints.get(sessionKey)) {
          store.evict(sessionKey);
        }
        if (!store.hasLive(sessionKey)) {
          const assembly = await this.buildSdkAssembly(
            tools, piModel, streamFn, gate, generation, Boolean(image),
          );
          await store.ensureConversation(conversationKey, assembly);
          this.assemblyFingerprints.set(sessionKey, fingerprint);
        }
      } catch (err) {
        slot.rejectReady(err);
        throw err;
      }
      slot.resolveReady();

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
            this.matchInstructionAck(event["message"]);
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

      let turnResult: SdkTurnResult;
      try {
        turnResult = await store.prompt(sessionKey, message, {
          streamFn,
          ...(image ? { images: [{ type: "image" as const, mimeType: image.mime, data: image.base64 }] } : {}),
          onEvent: tap,
        });
        slot.settled = true;
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
        // #1932: the SDK collector counts successful tool executions; keep
        // the transport-level counter in sync for status consumers.
        this._toolCallsSucceeded = turnResult.toolCallsSucceeded;

        // #1595: the terminal cause leads; a prior tool failure is supporting
        // context only. Never present a stale tool failure as the primary
        // reason.
        if (safety.terminalSafetyFailure && safety.lastTerminalIncident) {
          const inc = safety.lastTerminalIncident;
          logInfo(TAG, `sendPrompt: terminal safety incident (${inc.type}) — leading with terminal cause, prior tool failure retained as context`);
          throw new PiCoreToolExecutionError(buildTerminalDiagnostic(executionId, inc, this._lastToolFailure ?? undefined));
        }

        // #1932: a denied provider request settles as an error turn — the
        // recorded denial (typed) surfaces instead of a successful empty
        // answer. Safety incidents lead above; denials lead over text.
        const denied = this.turnState?.denied;
        if (denied !== undefined && denied !== null) {
          throw denied;
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
        this.turnState = null;
        // Outstanding leases never survive their turn: resolve-or-reject
        // exactly once, mirroring the old host settlement behavior.
        if (this.activeSlot === slot) this.rejectOutstandingLeases("turn_settled");
      }
    } catch (err) {
      slot.rejectReady(err);
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
      this.turnState = null;
      this.clearActiveSlot(slot);
    }
  }

  async resetSession(sessionKey: string): Promise<void> {
    // #1932: evict the live SDK conversation (Pi state stays on disk under
    // the same ID; the next turn reopens it). Requested effort survives on
    // the same transport instance.
    this.sdkStore?.evict(sessionKey);
    this.soulGates.delete(sessionKey);
    this.turnGenerations.delete(sessionKey);
    this.assemblyFingerprints.delete(sessionKey);
    // #1619: reset/compaction invalidates measured usage; requested effort
    // survives on the same transport instance.
    this.currentContextTokens = null;
    this.currentContextWindow = null;
    this.committedCandidate = null;
    // #1748: the session reset invalidates the cache identity — the next
    // sendPrompt derives a fresh one (main re-derives from the new session
    // key; subagents re-derive the same role-stable value).
    this.cacheIdentity = null;
  }

  async sendInterrupt(_reason?: string): Promise<void> {
    const slot = this.activeSlot;
    if (!slot || !this.sdkStore) return;
    // Signal-only cancel (never awaits provider acquisition); then observe
    // teardown up to a bound so a wedged provider cannot stall the
    // interrupt. Matches the old host's claim-terminal-now semantics.
    this.sdkStore.cancel(slot.sessionKey);
    const gate = this.soulGates.get(slot.sessionKey);
    gate?.cancel();
    const bound = this.interruptIdleTimeoutMs;
    await Promise.race([
      this.sdkStore.waitForIdle(slot.sessionKey).catch(() => { /* teardown errors never fail the interrupt */ }),
      new Promise<void>((resolve) => setTimeout(resolve, bound)),
    ]);
  }

  destroy(): void {
    const slot = this.activeSlot;
    if (slot && this.sdkStore) {
      this.sdkStore.cancel(slot.sessionKey);
    }
    this.sdkStore?.dispose();
    this.sdkStore = null;
    this.soulGates.clear();
    this.turnGenerations.clear();
    this.assemblyFingerprints.clear();
    this.turnState = null;
    this.rejectOutstandingLeases("transport_destroyed");
    this._isReady = false;
    this.committedCandidate = null;
    this.currentContextTokens = null;
    this.currentContextWindow = null;
  }

  /**
   * #1932: resolve the durable SDK conversation key for a session key.
   * Partitioning is by trusted principal, role, and workspace. Platform is
   * parsed opportunistically from a `platform:rest` session-key prefix and
   * reported as unknown when the key carries none — never fabricated.
   */
  private conversationKeyFor(sessionKey: string, context?: PromptRequestContext): SdkConversationKey {
    const prefix = sessionKey.includes(":") ? sessionKey.split(":")[0] ?? "" : "";
    const platform = /^[A-Za-z][A-Za-z0-9_-]*$/.test(prefix) ? prefix : "unknown";
    const durable = context?.durableContextIntent?.mode === "durable";
    return {
      sessionKey,
      principal: context?.userId ?? "unknown",
      platform,
      role: this.piRole,
      workspaceAlias: "chat",
      canonicalWorkspace: context?.executionScope?.cwd ?? "chat",
      memoryScope: durable ? "abmind" : "none",
      cwd: process.cwd(),
    };
  }

  /** #1932: lazy SDK store, one per transport (matches cache-identity scope). */
  private sdkStoreFor(): PiSdkConversationStore {
    if (!this.sdkStore) {
      this.sdkStore = new PiSdkConversationStore({
        stateDir: this.sdkStateDir,
        sessionStorageRoot: this.sdkSessionRoot,
        ...(this.sdkLoadSurface !== undefined ? { loadSurface: this.sdkLoadSurface } : {}),
        events: {
          onCompaction: (key) => {
            const gate = this.soulGates.get(key);
            gate?.invalidateOnCompaction();
            try {
              this.onCompactionRefresh?.(key);
            } catch { /* best effort; the gate already invalidated */ }
          },
        },
      });
    }
    return this.sdkStore;
  }

  /**
   * #1932: fingerprint of everything baked into the in-memory agent wrapper
   * (tool schemas/authorization, model, effort). A change rebuilds the
   * wrapper around the same conversation ID — Pi history is untouched.
   * Unstringifiable inputs fall back to a per-turn unique value (safe
   * direction: rebuild, never stale tools).
   */
  private assemblyFingerprint(
    toolContext: PiCoreToolContext,
    tools: Array<{ name?: string }>,
    piModel: PiAiModel<PiAiApi>,
  ): string {
    try {
      return JSON.stringify({
        tools: tools.map((t) => t.name ?? "?"),
        model: piModel.id ?? "?",
        effort: this.requestedEffort,
        sandbox: toolContext.sandboxPolicy,
        authMode: toolContext.authorizationMode ?? "",
        sessionType: toolContext.sessionType ?? "",
        cwd: toolContext.executionScope?.cwd ?? "",
        orc: toolContext.orcContext
          ? `${toolContext.orcContext.projectCardId}:${toolContext.orcContext.projectGeneration}:${toolContext.orcContext.intentKind}`
          : "",
      });
    } catch {
      return `unstringifiable-${Date.now()}-${Math.random()}`;
    }
  }

  /**
   * #1932: build the caller-owned Agent for a conversation. Model, stream
   * function, tools, and the abtars transform stay abtars-owned; the
   * AgentSession owns history, queues, compaction, and persistence around
   * it. AgentSession composes its own projections around (not instead of)
   * the transform below.
   */
  private async buildSdkAssembly(
    tools: Array<{ name?: string }>,
    piModel: PiAiModel<PiAiApi>,
    streamFn: unknown,
    gate: PiSoulGate,
    generation: number,
    hasImage: boolean,
  ): Promise<SdkAgentAssembly> {
    const { loadAndValidatePiAgentCore, convertMessagesToLlm, PI_AGENT_CORE_CONFIG } = await import("./pi-core-types.js");
    const loaded = await loadAndValidatePiAgentCore();
    const baseTools: Record<string, unknown> = {};
    for (const tool of tools) {
      const name = typeof tool.name === "string" && tool.name.length > 0 ? tool.name : `tool_${Object.keys(baseTools).length}`;
      baseTools[name] = tool;
    }
    const toolNames = Object.keys(baseTools);
    const agent = new loaded.module.Agent({
      initialState: {
        // Initial bundle text; per-request replacement keeps it current.
        systemPrompt: buildRequestSystemText(
          () => this.config.systemPrompt,
          this.turnState?.executionId ?? "unknown",
          this.turnState && this.turnState.source.mode === "durable" ? this.turnState.source.beforeMessageId : undefined,
          this.turnState?.volatileBlocks ?? [],
        ),
        model: piModel,
        messages: [],
        tools: tools as never,
        // #1619: the clamped effective level for the initial model; Pi Agent
        // turns it into the first request's reasoning option.
        thinkingLevel: this.resolveModel(this.config.candidate, hasImage).effective,
      },
      streamFn: streamFn as never,
      steeringMode: PI_AGENT_CORE_CONFIG.steeringMode,
      followUpMode: PI_AGENT_CORE_CONFIG.followUpMode,
      toolExecution: PI_AGENT_CORE_CONFIG.toolExecution,
      convertToLlm: (messages: AgentMessage[]) => convertMessagesToLlm(messages),
      transformContext: (messages: AgentMessage[], signal?: AbortSignal) => this.sdkTransform(messages, signal, gate, generation),
      // #1932: no model replacement exists — the single configured candidate
      // serves every turn, so there is never a next-turn update to compute.
      prepareNextTurnWithContext: async () => undefined,
    });
    const candidate = this.config.candidate;
    return {
      agent,
      baseTools,
      toolNames,
      provider: {
        providerId: candidate.provider,
        ...(candidate.endpoint !== undefined ? { baseUrl: candidate.endpoint } : {}),
        ...(candidate.apiKey !== undefined ? { apiKey: candidate.apiKey } : {}),
      },
    };
  }

  /**
   * #1932: request-scoped SDK transform. Pi owns the history flowing
   * through; abtars owns the per-request system bundle, safety round
   * limits, classified-literal scrubbing, and durable admission
   * (liveness probe + archive gap + soul gate). The fresh bundle is
   * request-scoped and never written back to Pi history.
   */
  /**
   * #1932: request-scoped SDK transform bound to one conversation turn.
   * Delegates to the shared factory; the per-turn holder supplies inputs
   * and the current config bundle is read fresh per request.
   */
  private sdkTransform(
    messages: AgentMessage[],
    signal: AbortSignal | undefined,
    gate: PiSoulGate,
    generation: number,
  ): Promise<AgentMessage[]> {
    const turn = this.turnState;
    if (!turn) return Promise.resolve([...messages]);
    const provider = turn.contextProvider;
    return buildSdkTransform({
      safety: turn.safety,
      source: turn.source,
      volatileBlocks: turn.volatileBlocks,
      executionId: turn.executionId,
      candidateKey: turn.candidateKey,
      ...(provider !== undefined ? { contextProvider: provider } : {}),
      projectContext: (input) => provider!.projectContext(input),
      memoryState: () => this._memoryToolDeps.current?.runtime.state,
      outboxHas: (sessionKey) => sharedArchiveOutbox.has(sessionKey),
      gate,
      generation,
      getSystemPrompt: () => this.config.systemPrompt,
      // First denial wins: Pi settles a denied request as an error turn
      // instead of propagating, so the tail surfaces the recorded denial.
      onDenied: (err) => {
        if (this.turnState && this.turnState.denied === null) this.turnState.denied = err;
      },
    })(messages, signal);
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
