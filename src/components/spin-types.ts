/**
 * spin-types.ts — Types and helpers for the Spin session system (#943, #953).
 * Importable by any module that needs ManagedSession or SessionType without pulling in the full Spin class.
 */

import type { AgentName } from "./subagent-runtime.js";
import type { ContentOutcome } from "./clean-response.js";
import type { Delivery, DeliveryMode } from "./tasks/task-types.js";
import type { IKiroTransport, RuntimeUsageSnapshot } from "./transport/kiro-transport.js";
import type { SandboxPolicy } from "./tool-sandbox.js";
import { logError } from "./logger.js";

export type SessionType = "A" | "B" | "C" | "T" | "P" | "S" | "O" | "W" | "D" | "H" | "K";

/**
 * #1611: provider-neutral candidate-selection policy for a session's
 * transport. `configured-only` restricts the persistent transport to the
 * configured candidate — no inherited Main candidate, no route fallback, no
 * second ACP model — and must be applied during transport construction (ACP
 * can fall back during initialization). The policy is immutable per attached
 * session; reusing a session with a conflicting policy fails closed.
 */
export type CandidatePolicy = "fallback-chain" | "configured-only";

/**
 * #1529: explicit durable-context intent carried from prompt construction
 * through Spin to the transport. Replaces the ambiguous optional cursor:
 * `not_required` means durable memory is not required (ephemeral execution is
 * valid); `required_unavailable` means durable memory IS required but cannot
 * be satisfied — the transport must fail closed before any provider request.
 */
export type DurableContextIntent =
  | { mode: "not_required" }
  | { mode: "durable"; beforeMessageId: number }
  | {
      mode: "required_unavailable";
      reason: "runtime_unavailable" | "record_failed" | "cursor_missing";
    };

/**
 * #1520: typed scheduled-dispatch admission rejection. Thrown by dispatchAwait
 * only for pre-execution gates (capacity/type-busy/model-cooldown); failures
 * after a model call starts are execution failures and must never be converted
 * to admission deferrals. Non-scheduler callers keep their queue/throw
 * semantics — the error carries the same codes for everyone.
 */
export type SpinAdmissionCode = "session_capacity" | "type_busy" | "model_cooldown";

export class SpinDispatchAdmissionError extends Error {
  readonly code: SpinAdmissionCode;
  readonly retryAt?: number;

  constructor(code: SpinAdmissionCode, message: string, retryAt?: number) {
    super(message);
    this.name = "SpinDispatchAdmissionError";
    this.code = code;
    this.retryAt = retryAt;
  }
}

// #1444: instruction kinds and delivery states
export type ExecutionInstructionKind = "steer" | "followUp";
export type ExecutionInstructionState =
  | "queued"
  | "leased"
  | "delivered"
  | "consumed"
  | "expired"
  | "failed";

export interface QueuedSessionInstruction {
  readonly id: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly kind: ExecutionInstructionKind;
  readonly source: "tui" | "platform" | "system";
  readonly text: string;
  readonly bytes: number;
  readonly createdAt: number;
  state: ExecutionInstructionState;
}

export type QueueInstructionResult =
  | { ok: true; instruction: QueuedSessionInstruction }
  | { ok: false; reason: "not_found" | "not_orc" | "not_busy" |
      "not_local" | "not_active" | "not_steerable" | "closing" |
      "stale_execution" | "too_large" | "queue_full" };

// #1444: instruction lease
export interface InstructionLease {
  readonly leaseId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly kind: ExecutionInstructionKind;
  readonly instructions: readonly QueuedSessionInstruction[];
}

// #1444: next-turn admission (separate from active-execution instruction ledger)
export interface NextTurnAdmission {
  admit(sessionId: string, message: { text: string }): QueueInstructionResult;
}

export type SteerEventType = "steer.queued" | "steer.consumed" | "steer.rejected" | "steer.expired" | "steer.failed";

export interface SteerEvent {
  type: SteerEventType;
  instructionIds: string[];
  sessionId: string;
  executionId: string;
  timestamp: number;
  description: string;
}

// ── #1248: Bounded /wait FIFO ─────────────────────────────────────────────────

export const MAX_WAIT_ITEMS = 20;
export const MAX_WAIT_ITEM_BYTES = 4 * 1024;
export const MAX_WAIT_TOTAL_BYTES = 32 * 1024;

export interface PendingWaitInstruction {
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
  readonly bytes: number;
}

export interface ManagedSession {
  id: string;                    // "1749563282_A_01"
  userId: string;
  platform: string;
  chatId: number;
  threadId?: number | string;

  // Transport
  transport?: IKiroTransport;
  transportOwner?: "bridge" | "runtime";
  releaseTransport?: () => Promise<void>;
  delivery: "streaming" | "simple";
  model?: string;
  provider?: string;
  /** #1432: Agent selected at allocation (K). Transport creation and
   *  reattachment use this; never derive a lifecycle type from an agent name. */
  executionAgent?: AgentName;
  pid?: number;
  peer?: string;                 // remote host name (hollow session)
  remoteSessionId?: string;      // session ID on the peer

  // Lifecycle
  active: boolean;               // true = current session for this userId+platform
  status: "creating" | "ready" | "paused" | "ended";
  idleTimeoutMs: number;
  lastActiveAt: number;
  motherId?: string;
  name?: string;

  // Context
  workingDir?: string;
  contextPercent?: number;

  // Metrics
  messageCount: number;
  tokenCount: number;
  /** Usage for the most recently completed sendPrompt turn, when reported. */
  lastTurnUsage?: RuntimeUsageSnapshot;
  /** In-memory usage total for this managed session. Not persisted. */
  sessionUsage?: RuntimeUsageSnapshot;
  toolCallCount: number;

  // Session event log (last 5 events)
  log: string[];

  // Display
  shortIndex: number;

  // Pipeline state (#1040 — merged from SessionRegistry)
  busy: boolean;
  queue: Array<{ msg: import("../types/platform.js").InboundMessage; adapter: import("../types/platform.js").PlatformAdapter }>;
  fullMode: boolean;
  pendingStart: boolean;
  seen: boolean;
  compacting: boolean;
  ctxWarned: boolean;
  compactFailures: number;
  primingTerms: string[];
  /** #1248: Bounded FIFO for /wait instructions (replaced unbounded string). */
  pendingWait: PendingWaitInstruction[];

  // Completion buffer (#1040 — merged from completion-buffer.ts)
  completions: Array<{ sessionId: string; goal: string; status: string; result: string; elapsedMs: number; inputTokens: number; outputTokens: number }>;

  // Session-scoped metadata (#1271). Set ONCE at session allocation from
  // `SpinSessionSpec.metadata`; never merged on `sessionId` reuse. Use
  // `onStepComplete`'s event for per-step data.
  metadata?: Record<string, unknown>;

  // #1332/#1361: Cooperative steering queue for any active execution
  instructionQueue: QueuedSessionInstruction[];
  activeExecutionId?: string;
  /** #1611: immutable candidate policy of the attached transport, recorded on
   *  first attachment. Conflicting reuse fails closed. */
  candidatePolicy?: CandidatePolicy;
  /** #1502 §7: execution control bound to the active run, so killSession /
   *  endSession / shutdown can cancel the underlying execution without the
   *  caller being in scope. Set by spin() from spec.executionControl. */
  executionControl?: import("./execution-control.js").ExecutionControl;
  /** #1361: True while the current execution is accepting steering continuations. */
  steeringAccepting: boolean;

  // #1319: Orc activity correlation
  activeCardId?: number;
  activeRootCardId?: number;
  // #1480: Orc invocation context for durable project ownership fencing.
  orcContext?: import("./orc-project/orc-project-contracts.js").OrcInvocationContextV1;
}

export interface SpinRequest {
  type: SessionType;
  agent?: import("./subagent-runtime.js").AgentName; // override typeAgent() default
  goal: string;
  title?: string;
  executionControl?: import("./execution-control.js").WorkerExecutionControl;
  source: "task" | "user" | "agent" | "peer";
  cardId?: number;
  parentCardId?: number;
  deliveryMode?: DeliveryMode;
  delivery?: Delivery;
  /** #1520: scheduled runs create cards locked (delivery_ready=0) until the
   *  shared settler wins successful validation and releases delivery. */
  deliveryReady?: boolean;
  priority?: string;
  tools?: SandboxPolicy;
  timeoutMs?: number;
  /** #1506: absolute deadline owned by the scheduled caller. */
  deadlineAt?: number;
  callbackPeer?: string; // #675: peer to notify on completion
  sourcePeer?: string;   // #949: which peer delegated this task
  chatId?: string;      // #1008: delivery target chat (fallback: masterChatId)
  maxToolRounds?: number; // #1283: per-task circuit breaker override
  /** #1366: Worker acceptance contract (supervised dispatch). */
  contract?: import("./worker-contract.js").WorkerAcceptanceContractV1;
  /** #1366: Pre-allocated attempt ID for supervision correlation. */
  attemptId?: string;
  /** #1502: Every caller must explicitly choose the single Kanban settlement owner. */
  settlementOwner: "spin" | "caller";
  /** #1502 Task 10: explicit task-local cwd/env for tool execution. */
  executionScope?: import("./tasks/task-package.js").ToolExecutionScope;
  /** #1480: Orc invocation context for durable project ownership fencing. */
  orcContext?: import("./orc-project/orc-project-contracts.js").OrcInvocationContextV1;
  /** #1644: immutable project authority for supervised child creation — bound
   *  from the Orc invocation context, never from tool arguments. */
  authority?: { projectCardId: number; projectGeneration: number; scheduledRunId?: string };
}

// ── #1271: unified session API ──────────────────────────────────────────

export interface SpinSessionSpec {
  type: SessionType;

  // Identity
  userId?: string;          // default: master user
  platform?: string;        // default: "background"
  chatId?: number;          // default: 0

  // Work
  goal?: string;            // user-facing → creates kanban card
  prompt?: string;          // background one-shot → no card
  // Reuse / continuation (multi-step sleep, pipeline main turn)
  sessionId?: string;       // reuse an existing session (send next prompt to it)

  // Lifecycle overrides (default comes from the profile)
  active?: boolean;
  persistent?: boolean;
  terminateAfter?: "call" | "response" | "external";

  // Kanban tracking
  cardId?: number;
  parentCardId?: number;
  title?: string;
  priority?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  source?: "task" | "user" | "agent" | "peer";

  // Execution
  agent?: import("./subagent-runtime.js").AgentName; // override the profile's agent
  timeoutMs?: number;
  /** #1506: absolute deadline owned by the scheduled caller. */
  deadlineAt?: number;
  /** #1611: provider silence allowance for the current logical sleep step. */
  providerInactivityTimeoutMs?: number;
  /** Control-plane cancellation for bounded background provider work. */
  signal?: AbortSignal;
  /** #1611: candidate-selection policy for the persistent transport.
   *  Defaults to `fallback-chain`; sleep sets `configured-only`. */
  candidatePolicy?: CandidatePolicy;
  maxToolRounds?: number; // #1283: per-task circuit breaker override

  // Delivery (continuation / pipeline)
  deliveryMode?: DeliveryMode;
  delivery?: Delivery;
  /** #1520: scheduled runs create cards delivery-locked until settlement. */
  deliveryReady?: boolean;
  imageContent?: unknown;   // → sendPrompt arg 3 (image passthrough)
  callbackPeer?: string;
  sourcePeer?: string;
  // #1529: explicit durable-context intent for the inbound turn. An omitted
  // field means the caller is outside the inbound durable pipeline and
  // defaults to not-required at the transport boundary; inbound pipeline
  // calls always provide the explicit intent.
  durableContextIntent?: DurableContextIntent;
  /** #1335: structured current turn components for Direct API cache-stable assembly. */
  directContextTurn?: {
    rawUserText: string;
    volatileBlocks: ReadonlyArray<{ kind: string; content: string }>;
  };
  // NOTE: no `stream` field. Streaming is a transport property
  // (transport.onIntermediateResponse / onToolCallStart / onSegmentBreak) that the
  // PIPELINE sets before calling spin() and resets in its finally — Spin never touches it.
  // sendPrompt is (sessionKey, message, image?, context?: PromptRequestContext) — 4 args, no stream.

  // #1366: Worker supervision contract and attempt ID
  contractId?: string;
  attemptId?: string;
  // #1248: Execution control for cancellation
  executionControl?: import("./execution-control.js").WorkerExecutionControl;
  // #1502: Every caller must explicitly choose the single Kanban settlement owner.
  settlementOwner: "spin" | "caller";
  /** #1502 Task 10: explicit task-local cwd/env for tool execution. */
  executionScope?: import("./tasks/task-package.js").ToolExecutionScope;

  // Extension / future-proofing
  metadata?: Record<string, unknown>;  // session-scoped initial data, set ONCE at allocation
                                        // (not merged on sessionId-reuse — see design §2)

  // #1480: Orc invocation context for durable project ownership fencing.
  orcContext?: import("./orc-project/orc-project-contracts.js").OrcInvocationContextV1;

  // Result
  await?: boolean;

  // Progress hook (partial-result reporting — sleep, workers)
  onStepComplete?: (event: StepEvent) => void | Promise<void>;
}

/** #1651 v2: truthful step event — success carries the settled result and its
 *  outcome; failure carries the error. Never both. */
export type StepEvent =
  | {
      sessionId: string;
      cardId?: number;
      stepIndex: number;
      result: string;
      outcome: ContentOutcome;
      error?: undefined;
      durationMs: number;
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      sessionId: string;
      cardId?: number;
      stepIndex: number;
      result?: undefined;
      outcome?: undefined;
      error: Error;
      durationMs: number;
      inputTokens?: number;
      outputTokens?: number;
    };

/** #1651 v2: dispatch identity for a non-awaited `spin()` call. */
export interface SpinDispatchResult {
  sessionId: string;
  cardId?: number;
}

/**
 * #1651 v2: the settled result of a successfully awaited `spin()` call.
 * `result` is the provider's own string — never fabricated, so it MAY be
 * empty. `outcome` is Spin's single classification of the turn. Both are
 * required: no consumer may reconstruct the outcome from result truthiness.
 */
export interface AwaitedSpinResult extends SpinDispatchResult {
  result: string;
  outcome: ContentOutcome;
}

/** #1651 v2: `dispatchAwait()` preserves the awaited contract. */
export interface DispatchAwaitedResult {
  cardId: number;
  result: string;
  outcome: ContentOutcome;
}

/**
 * #1361: Per-execution continuation-capable driver for Spin's execution loop.
 *  #1531: `steer` is a per-lease acknowledgement operation (`Promise<void>`).
 *  It acknowledges only the supplied lease; it never produces the execution's
 *  final response — the initial `send` promise remains the sole source of the
 *  final text. Drivers without native steering simply omit `steer` and use the
 *  sequential post-send continuation path. */
export interface SpinExecutionDriver {
  send(prompt: string, image?: { mime: string; base64: string }, context?: import("./transport/kiro-transport.js").PromptRequestContext): Promise<string>;
  steer?(content: string, lease: import("./spin-types.js").InstructionLease): Promise<void>;
  close(): Promise<void>;
  readonly ephemeral: boolean;
}

export interface DispatchBackgroundOptions {
  prompt: string;
  type?: SessionType;      // default "S" (ephemeral one-shot)
  agent?: import("./subagent-runtime.js").AgentName;  // override the profile agent
  timeoutMs?: number;
  /** Abort the provider execution and settle the one-shot caller. */
  signal?: AbortSignal;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function sessionType(session: ManagedSession): SessionType {
  const type = session.id.split("_")[1];
  if (!type) logError("spin-types", `Malformed session ID "${session.id}" — no type segment, defaulting to A`);
  return (type ?? "A") as SessionType;
}

/** Session type from a raw session-id string (companion to sessionType(session)). */
export function sessionTypeOf(sessionId: string): SessionType {
  return (sessionId.split("_")[1] ?? "A") as SessionType;
}

/**
 * #1022: compaction fires only for A (main) and C (coding) session types.
 * Every other type (B, D, O, S, T, P, W, H) is never compacted. Hard requirement.
 */
const COMPACTABLE_TYPES: ReadonlySet<SessionType> = new Set<SessionType>(["A", "C"]);
export function isCompactable(sessionId: string): boolean {
  return COMPACTABLE_TYPES.has(sessionTypeOf(sessionId));
}

export function sessionCreatedAt(session: ManagedSession): number {
  return parseInt(session.id.split("_")[0] ?? "0", 10) * 1000;
}

const TYPE_LABELS: Record<SessionType, string> = {
  A: "Main", B: "Browse", C: "Code", T: "Task", P: "Peer",
  S: "System", O: "Orc", W: "Worker", D: "Dreamy", H: "Healer", K: "Skill",
};

const TYPE_AGENT_MAP: Partial<Record<SessionType, AgentName>> = {
  A: "professor", C: "coding", B: "browsie", D: "dreamy",
  O: "professor", T: "professor", W: "browsie", H: "coding",
  K: "professor",
};

export function typeLabel(t: SessionType): string { return TYPE_LABELS[t]; }

/** #1271: single source of truth = SessionProfile. Kept as fallback for callers
 *  that import spin-types without pulling in spin-profiles. */
export function typeAgent(t: SessionType): AgentName {
  try {
    // Lazy require to avoid circular import (spin-profiles → spin-types).
    // The static map is also kept for back-compat in the standalone abmind path.
    const { SESSION_PROFILES } = require("./spin-profiles.js") as typeof import("./spin-profiles.js");
    return SESSION_PROFILES[t].agent;
  } catch {
    return TYPE_AGENT_MAP[t] ?? "professor";
  }
}

export function parseSessionType(input: string): SessionType | null {
  switch (input.toLowerCase()) {
    case "browse": return "B";
    case "code": return "C";
    case "task": return "T";
    default: return null;
  }
}
